import type { AgentEvent, EngineCapabilities, EngineError, UsageDelta } from '@ai-harness/shared';
import { execa } from 'execa';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isWindows } from '../lib/platform';
import { firstSemver, which } from './binary';
import { classifyEngineError } from './errors';
import type {
  AdapterEnv,
  AgentEngineAdapter,
  AgentRunInput,
  AgentRunResult,
  AuthStatusResult,
  DetectResult,
  LoginFlow,
} from './types';

export const emptyUsage = (): UsageDelta => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

/** Mutable state an adapter's line parser fills in while a run streams. */
export interface RunState {
  sessionId: string | null;
  /** Accumulated assistant text (deltas or full messages). */
  text: string;
  /** Authoritative final answer, when the CLI reports one. */
  finalText: string | null;
  usage: UsageDelta;
  /** true/false once the CLI reported an outcome. */
  succeeded: boolean | null;
  error: EngineError | null;
  /** Adapter-specific scratch space. */
  scratch: Record<string, unknown>;
}

export interface BuiltCommand {
  args: string[];
  /** Written to stdin, which is then closed. */
  stdin?: string;
  env?: Record<string, string>;
}

const STDERR_TAIL = 16_000;
const MAX_ARG_PROMPT = 120_000;

export const truncate = (s: string, n = 2000) =>
  s.length > n ? `${s.slice(0, n)}… (${s.length - n} more chars)` : s;

/** Prepend a system prompt for CLIs that have no dedicated flag. */
export const withSystemPrompt = (prompt: string, system?: string | null) =>
  system ? `<system_instructions>\n${system}\n</system_instructions>\n\n${prompt}` : prompt;

export function addUsage(into: UsageDelta, d: UsageDelta): void {
  into.inputTokens += d.inputTokens;
  into.outputTokens += d.outputTokens;
  into.cacheReadTokens += d.cacheReadTokens;
  into.cacheWriteTokens += d.cacheWriteTokens;
  if (d.costUsd !== undefined) into.costUsd = (into.costUsd ?? 0) + d.costUsd;
  if (d.model) into.model = d.model;
}

export function assertArgPromptSize(prompt: string, engine: string) {
  if (prompt.length > MAX_ARG_PROMPT) {
    throw new Error(
      `${engine} receives prompts as a command-line argument; this prompt is too large (${prompt.length} chars)`,
    );
  }
}

/**
 * Shared machinery for CLI-backed engines: binary discovery, version
 * detection, and a streaming run loop that turns stdout lines into
 * normalised AgentEvents. Processes are spawned without a shell.
 */
export abstract class CliAdapter implements AgentEngineAdapter {
  abstract readonly id: string;
  abstract readonly displayName: string;
  abstract readonly description: string;
  abstract readonly installGuideUrl: string | null;
  abstract readonly installCommand: string | null;
  abstract readonly capabilities: EngineCapabilities;
  readonly staticModels: { id: string; label: string }[] = [];

  protected versionArgs = ['--version'];
  /** Env var the stored API key is exported as, if supported. */
  protected apiKeyEnvVar: string | null = null;

  constructor(protected readonly env: AdapterEnv) {}

  /** Names (looked up on PATH) or absolute paths, in priority order. */
  protected abstract binaryCandidates(): string[];
  protected abstract buildCommand(input: AgentRunInput): BuiltCommand;
  protected abstract parseLine(line: string, state: RunState): AgentEvent[];
  abstract getAuthStatus(): Promise<AuthStatusResult>;
  abstract startLogin(): Promise<LoginFlow>;
  abstract logout(): Promise<void>;

  async resolveBinary(): Promise<string | null> {
    const override = this.env.binaryOverride();
    if (override) return which(override, this.env.extraPath);
    for (const c of this.binaryCandidates()) {
      const found = await which(c, this.env.extraPath);
      if (found) return found;
    }
    return null;
  }

  protected async requireBinary(): Promise<string> {
    const bin = await this.resolveBinary();
    if (!bin) throw new Error(`${this.displayName} is not installed`);
    return bin;
  }

  async detectInstalled(): Promise<DetectResult> {
    const path = await this.resolveBinary();
    if (!path) return { installed: false };
    const r = await this.exec(path, this.versionArgs, 15_000);
    return { installed: true, path, version: firstSemver(`${r.stdout}\n${r.stderr}`) ?? undefined };
  }

  protected apiKeyEnv(): Record<string, string> {
    const key = this.env.apiKey();
    return key && this.apiKeyEnvVar ? { [this.apiKeyEnvVar]: key } : {};
  }

  /** Run a short auxiliary command (version, auth status…). Never throws. */
  protected async exec(bin: string, args: string[], timeout = 20_000) {
    const r = await execa(bin, args, {
      reject: false,
      timeout,
      stdin: 'ignore',
      env: { ...this.apiKeyEnv(), NO_COLOR: '1' },
    });
    return {
      exitCode: r.exitCode ?? null,
      stdout: String(r.stdout ?? ''),
      stderr: String(r.stderr ?? ''),
      timedOut: r.timedOut,
    };
  }

  parseUsage(event: AgentEvent): UsageDelta | null {
    return event.kind === 'usage' ? event.usage : null;
  }

  classifyError(output: string): EngineError {
    return classifyEngineError(output);
  }

  async run(input: AgentRunInput, onEvent: (e: AgentEvent) => void): Promise<AgentRunResult> {
    const started = Date.now();
    const state: RunState = {
      sessionId: null,
      text: '',
      finalText: null,
      usage: emptyUsage(),
      succeeded: null,
      error: null,
      scratch: {},
    };
    const emit = (e: AgentEvent) => {
      if (e.kind === 'session') state.sessionId = e.sessionId;
      if (e.kind === 'usage') addUsage(state.usage, e.usage);
      if (e.kind === 'text') state.text += e.delta ? e.text : (state.text ? '\n' : '') + e.text;
      onEvent(e);
    };
    const fail = (error: EngineError, exitCode: number | null = null): AgentRunResult => ({
      status: 'failed',
      sessionId: state.sessionId,
      finalText: state.finalText ?? state.text,
      usage: state.usage,
      durationMs: Date.now() - started,
      exitCode,
      error,
    });

    let bin: string;
    let cmd: BuiltCommand;
    try {
      bin = await this.requireBinary();
      cmd = this.buildCommand(input);
    } catch (err) {
      return fail({ kind: 'TOOL_ERROR', message: (err as Error).message, resetAt: null });
    }

    const child = execa(bin, cmd.args, {
      cwd: input.cwd,
      input: cmd.stdin ?? '',
      env: { ...this.apiKeyEnv(), ...cmd.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      reject: false,
      buffer: false,
      // On Windows we own cancellation below (execa would kill only cmd.exe and
      // orphan the real engine); elsewhere execa's signal reaches the process.
      cancelSignal: isWindows ? undefined : input.signal,
      timeout: input.timeoutMs,
      forceKillAfterDelay: 5000,
    });

    // On Windows an npm CLI shim is a `.cmd`, so the engine runs as a grandchild
    // (cmd.exe → node). Killing only cmd.exe orphans the grandchild, which keeps
    // the output pipe open so the run can't settle. Own cancellation here: after a
    // short grace so output already written can be read, kill the whole tree via
    // `taskkill /t` (cmd.exe must still be alive to enumerate its children). No-op
    // on POSIX, where the binary is the direct child and execa handles the signal.
    if (isWindows && input.signal) {
      input.signal.addEventListener(
        'abort',
        () => {
          const pid = child.pid;
          if (!pid) return;
          setTimeout(() => {
            try {
              spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
            } catch {
              /* best effort — the tree may already be gone */
            }
          }, 200);
        },
        { once: true },
      );
    }

    let stderrTail = '';
    const stdoutDone = new Promise<void>((resolve) => {
      if (!child.stdout) return resolve();
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        let events: AgentEvent[];
        try {
          events = this.parseLine(line, state);
        } catch {
          events = [{ kind: 'log', stream: 'stdout', line: truncate(line, 4000) }];
        }
        for (const e of events) emit(e);
      });
      rl.on('close', () => resolve());
    });
    const stderrDone = new Promise<void>((resolve) => {
      if (!child.stderr) return resolve();
      const rl = createInterface({ input: child.stderr, crlfDelay: Infinity });
      rl.on('line', (line) => {
        stderrTail = (stderrTail + line + '\n').slice(-STDERR_TAIL);
        if (line.trim()) emit({ kind: 'log', stream: 'stderr', line: truncate(line, 4000) });
      });
      rl.on('close', () => resolve());
    });

    const result = await child;
    await Promise.all([stdoutDone, stderrDone]);
    const exitCode = result.exitCode ?? null;
    const finalText = state.finalText ?? state.text;

    if (result.isCanceled || input.signal?.aborted) {
      return {
        status: 'cancelled',
        sessionId: state.sessionId,
        finalText,
        usage: state.usage,
        durationMs: Date.now() - started,
        exitCode,
        error: null,
      };
    }
    if (result.timedOut) {
      return fail(
        {
          kind: 'UNKNOWN',
          message: `Timed out after ${Math.round((input.timeoutMs ?? 0) / 1000)}s`,
          resetAt: null,
        },
        exitCode,
      );
    }
    const failed =
      state.succeeded === false ||
      state.error !== null ||
      (exitCode !== 0 && state.succeeded !== true);
    if (!failed) {
      return {
        status: 'succeeded',
        sessionId: state.sessionId,
        finalText,
        usage: state.usage,
        durationMs: Date.now() - started,
        exitCode,
        error: null,
      };
    }
    // Refine the error with everything we know (parsed error, stderr, final text).
    const evidence = [
      state.error?.message,
      stderrTail,
      state.succeeded === false ? finalText : '',
      exitCode ? `exit code ${exitCode}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const classified = this.classifyError(evidence);
    const error: EngineError =
      state.error && state.error.kind !== 'UNKNOWN'
        ? { ...state.error, resetAt: state.error.resetAt ?? classified.resetAt }
        : { ...classified, message: state.error?.message ?? classified.message };
    return fail(error, exitCode);
  }
}

/** Read a dotted path ("a.b.0.c") from a JSON value. */
export function getPath(obj: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
