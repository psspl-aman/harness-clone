import type { AgentEvent, UsageWindow } from '@agentforge/shared';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { classifyEngineError } from '../errors';
import {
  CliAdapter,
  num,
  truncate,
  withSystemPrompt,
  type BuiltCommand,
  type RunState,
} from '../cli-adapter';
import type { AgentRunInput, AgentRunResult, AuthStatusResult, LoginFlow } from '../types';

type Json = Record<string, unknown>;

/** Label used when neither the run nor the Codex config names a model. */
export const CODEX_DEFAULT_MODEL = 'codex (default)';

const codexHome = () => process.env.CODEX_HOME || join(homedir(), '.codex');

/**
 * Map a Codex `rate_limits` object ({primary, secondary: {used_percent,
 * window_minutes, resets_at | resets_in_seconds}}) onto a rate_limit event,
 * naming windows like Claude's (five_hour / seven_day) so the UI treats them
 * the same. Returns null when there is nothing usable.
 */
export function codexRateLimitEvent(rl: unknown, now = Date.now()): AgentEvent | null {
  if (!rl || typeof rl !== 'object') return null;
  const windows: UsageWindow[] = [];
  for (const key of ['primary', 'secondary'] as const) {
    const w = (rl as Json)[key] as Json | null | undefined;
    if (!w || typeof w !== 'object') continue;
    const pct = typeof w.used_percent === 'number' ? w.used_percent : null;
    const mins = num(w.window_minutes);
    const resetsAt =
      typeof w.resets_at === 'number'
        ? w.resets_at * 1000
        : typeof w.resets_in_seconds === 'number'
          ? now + w.resets_in_seconds * 1000
          : null;
    const name =
      mins === 300
        ? 'five_hour'
        : mins === 10080
          ? 'seven_day'
          : !mins
            ? key
            : mins % 1440 === 0
              ? `${mins / 1440}_day`
              : `${Math.round(mins / 60)}_hour`;
    windows.push({
      name,
      utilization: pct === null ? null : Math.min(1, Math.max(0, pct / 100)),
      resetsAt,
      status:
        pct === null ? 'unknown' : pct >= 100 ? 'rejected' : pct >= 80 ? 'warning' : 'allowed',
    });
  }
  if (!windows.length) return null;
  const rejected = windows.filter((w) => w.status === 'rejected');
  const status = rejected.length
    ? 'rejected'
    : windows.some((w) => w.status === 'warning')
      ? 'warning'
      : windows.every((w) => w.status === 'unknown')
        ? 'unknown'
        : 'allowed';
  const resetsAt = rejected.length
    ? Math.max(...rejected.map((w) => w.resetsAt ?? 0)) || null
    : (windows[0]!.resetsAt ?? null);
  return { kind: 'rate_limit', status, resetsAt, windows };
}

/** Top-level `model = "…"` from Codex's config.toml (read-only), if set. */
export function codexConfigModel(home = codexHome()): string | null {
  try {
    const toml = readFileSync(join(home, 'config.toml'), 'utf8');
    const top = toml.split(/^\s*\[/m)[0] ?? ''; // stop at the first [table]
    return /^\s*model\s*=\s*["']([^"']+)["']/m.exec(top)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * `codex exec --json` doesn't stream rate limits or the model, but Codex
 * writes both to its session rollout file
 * (`sessions/YYYY/MM/DD/rollout-…-<thread id>.jsonl`): `event_msg` token_count
 * payloads carry `rate_limits`, `turn_context` carries `model`. Only the
 * newest 14 day folders are searched.
 */
export function readCodexRollout(
  threadId: string,
  home = codexHome(),
): { model: string | null; rateLimits: unknown } | null {
  const root = join(home, 'sessions');
  const desc = (dir: string) => {
    try {
      return readdirSync(dir).sort().reverse();
    } catch {
      return [];
    }
  };
  const days: string[] = [];
  outer: for (const y of desc(root))
    for (const m of desc(join(root, y)))
      for (const d of desc(join(root, y, m))) {
        days.push(join(root, y, m, d));
        if (days.length >= 14) break outer;
      }
  for (const day of days) {
    const file = desc(day).find((f) => f.endsWith(`${threadId}.jsonl`));
    if (!file) continue;
    let model: string | null = null;
    let rateLimits: unknown = null;
    try {
      for (const line of readFileSync(join(day, file), 'utf8').split('\n')) {
        if (!line.includes('"turn_context"') && !line.includes('"rate_limits"')) continue;
        try {
          const d = JSON.parse(line) as Json;
          const p = (d.payload ?? {}) as Json;
          if (d.type === 'turn_context' && typeof p.model === 'string') model = p.model;
          if (p.rate_limits) rateLimits = p.rate_limits;
        } catch {
          /* partial line */
        }
      }
    } catch {
      return null;
    }
    return { model, rateLimits };
  }
  return null;
}

/**
 * The most recent `rate_limits` from any rollout file (newest day, newest file). Rate-limit
 * windows are account-wide, so this is a fallback when the run's own rollout is missing or wrote
 * no limits (e.g. a run that failed instantly at the usage cap and left no thread file).
 */
export function latestCodexRateLimits(home = codexHome()): unknown {
  const root = join(home, 'sessions');
  const desc = (dir: string) => {
    try {
      return readdirSync(dir).sort().reverse();
    } catch {
      return [];
    }
  };
  let scanned = 0;
  for (const y of desc(root))
    for (const m of desc(join(root, y)))
      for (const d of desc(join(root, y, m))) {
        for (const file of desc(join(root, y, m, d))) {
          if (!file.endsWith('.jsonl')) continue;
          if (++scanned > 40) return null;
          try {
            const lines = readFileSync(join(root, y, m, d, file), 'utf8').split('\n');
            for (let i = lines.length - 1; i >= 0; i--) {
              if (!lines[i]!.includes('"rate_limits"')) continue;
              const p = (JSON.parse(lines[i]!).payload ?? {}) as Json;
              if (p.rate_limits) return p.rate_limits;
            }
          } catch {
            /* skip unreadable/partial file */
          }
        }
      }
  return null;
}

/**
 * OpenAI Codex CLI (`codex exec --json`). Event contract from the Codex
 * docs and codex-rs/exec/src/exec_events.rs: thread.started{thread_id},
 * turn.started, turn.completed{usage}, turn.failed{error}, item.* {item},
 * error{message}. Auth via `codex login status` (exit 0 = logged in).
 */
export class CodexAdapter extends CliAdapter {
  readonly id = 'codex';
  readonly displayName = 'OpenAI Codex';
  readonly description =
    'OpenAI’s coding agent CLI. Sign in with ChatGPT or use an OpenAI API key.';
  readonly installGuideUrl = 'https://github.com/openai/codex#quickstart';
  readonly installCommand = 'npm install -g @openai/codex';
  readonly capabilities = {
    login: true,
    logout: true,
    apiKey: true,
    resume: true,
    modelList: false,
    effort: true,
  };
  override readonly staticModels = [
    { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
    { id: 'gpt-5', label: 'GPT-5' },
    { id: 'o4-mini', label: 'o4-mini' },
  ];
  protected override apiKeyEnvVar = 'CODEX_API_KEY';

  protected binaryCandidates(): string[] {
    return ['codex'];
  }

  protected buildCommand(input: AgentRunInput): BuiltCommand {
    const args = ['exec', '--json', '--skip-git-repo-check', '-C', input.cwd];
    if (input.model) args.push('-m', input.model);
    // Config override (TOML value): same key as `model_reasoning_effort` in ~/.codex/config.toml.
    if (input.effort) args.push('-c', `model_reasoning_effort="${input.effort}"`);
    if (input.permission === 'readonly') args.push('--sandbox', 'read-only');
    else args.push('--sandbox', 'workspace-write');
    if (input.permission === 'full') args.push('-c', 'sandbox_workspace_write.network_access=true');
    if (input.resumeSessionId) args.push('resume', input.resumeSessionId);
    args.push('-'); // read the prompt from stdin
    return { args, stdin: withSystemPrompt(input.prompt, input.systemPrompt) };
  }

  protected parseLine(line: string, state: RunState): AgentEvent[] {
    const d = JSON.parse(line) as Json;
    const started = (state.scratch.started ??= new Set<string>()) as Set<string>;
    const out: AgentEvent[] = [];
    // Some Codex builds put rate limits / the model on stream events; use them if so.
    const limits = codexRateLimitEvent(d.rate_limits ?? ((d.payload ?? {}) as Json).rate_limits);
    if (limits) out.push(limits);
    if (typeof d.model === 'string') state.scratch.model = d.model;
    switch (d.type) {
      case 'thread.started':
        out.push({
          kind: 'session',
          sessionId: String(d.thread_id),
          model: typeof d.model === 'string' ? d.model : undefined,
        });
        break;
      case 'turn.completed': {
        const u = (d.usage ?? {}) as Json;
        const cached = num(u.cached_input_tokens);
        out.push({
          kind: 'usage',
          usage: {
            // OpenAI input_tokens include cached tokens; report them separately.
            inputTokens: Math.max(0, num(u.input_tokens) - cached),
            outputTokens: num(u.output_tokens) + num(u.reasoning_output_tokens),
            cacheReadTokens: cached,
            cacheWriteTokens: num(u.cache_write_input_tokens),
            ...(typeof state.scratch.model === 'string' ? { model: state.scratch.model } : {}),
          },
        });
        state.succeeded ??= true;
        break;
      }
      case 'turn.failed':
      case 'error': {
        const message =
          d.type === 'error'
            ? String(d.message ?? 'Codex error')
            : String(((d.error ?? {}) as Json).message ?? 'Turn failed');
        state.succeeded = false;
        state.error = classifyEngineError(message);
        out.push({ kind: 'error', message, fatal: true });
        break;
      }
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item = (d.item ?? {}) as Json;
        const id = String(item.id ?? '');
        const done = d.type === 'item.completed';
        const call = (name: string, input: unknown) => {
          if (!started.has(id)) {
            started.add(id);
            out.push({ kind: 'tool_call', id, name, input });
          }
        };
        switch (item.type) {
          case 'agent_message':
            if (done) {
              out.push({ kind: 'text', text: String(item.text ?? '') });
              state.finalText = String(item.text ?? '');
            }
            break;
          case 'reasoning':
            if (done) out.push({ kind: 'thinking', text: String(item.text ?? '') });
            break;
          case 'command_execution':
            call('shell', { command: item.command });
            if (done)
              out.push({
                kind: 'tool_result',
                id,
                ok: item.status === 'completed' && (item.exit_code ?? 0) === 0,
                output: truncate(String(item.aggregated_output ?? '')),
              });
            break;
          case 'file_change':
            call('file_change', { changes: item.changes });
            if (done) out.push({ kind: 'tool_result', id, ok: item.status === 'completed' });
            break;
          case 'mcp_tool_call':
            call(`${String(item.server)}.${String(item.tool)}`, item.arguments);
            if (done) {
              const err = item.error as Json | null;
              out.push({
                kind: 'tool_result',
                id,
                ok: item.status === 'completed' && !err,
                output: truncate(err ? String(err.message) : JSON.stringify(item.result ?? '')),
              });
            }
            break;
          case 'error':
            if (done)
              out.push({ kind: 'error', message: String(item.message ?? ''), fatal: false });
            break;
          default:
            break; // web_search, todo_list, collab_tool_call: informational
        }
        break;
      }
      default:
        break;
    }
    return out;
  }

  /**
   * After the CLI exits, fill in what `exec --json` leaves out: the model on
   * usage (rollout → requested model → config.toml → "codex (default)") and
   * the 5-hour / 7-day usage windows from the session rollout file.
   */
  override async run(
    input: AgentRunInput,
    onEvent: (e: AgentEvent) => void,
  ): Promise<AgentRunResult> {
    let streamedLimits = false;
    const pending: AgentEvent[] = [];
    const result = await super.run(input, (e) => {
      if (e.kind === 'rate_limit') streamedLimits = true;
      // Usage arrives at turn end; hold it until the model is known.
      if (e.kind === 'usage' && !e.usage.model) pending.push(e);
      else onEvent(e);
    });
    const rollout = result.sessionId ? readCodexRollout(result.sessionId) : null;
    const model =
      result.usage.model ||
      rollout?.model ||
      input.model ||
      codexConfigModel() ||
      CODEX_DEFAULT_MODEL;
    const u = result.usage;
    if (u.inputTokens || u.outputTokens || u.cacheReadTokens) u.model = model;
    for (const e of pending) {
      if (e.kind === 'usage') e.usage.model = model;
      onEvent(e);
    }
    if (!streamedLimits) {
      const limits = rollout?.rateLimits ?? latestCodexRateLimits();
      const ev = limits ? codexRateLimitEvent(limits) : null;
      if (ev) onEvent(ev);
    }
    return result;
  }

  async getAuthStatus(): Promise<AuthStatusResult> {
    if (this.env.apiKey())
      return {
        status: 'ACTIVE',
        accountLabel: 'API key',
        detail: 'Using the OpenAI API key stored in AgentForge',
      };
    const r = await this.exec(await this.requireBinary(), ['login', 'status']);
    const text = `${r.stdout}\n${r.stderr}`.trim();
    const first = text.split('\n')[0] ?? '';
    if (r.exitCode === 0)
      return {
        status: 'ACTIVE',
        accountLabel: first.replace(/^Logged in using /, ''),
        detail: first,
      };
    if (/not logged in/i.test(text)) return { status: 'LOGGED_OUT', detail: 'Not signed in' };
    return { status: 'UNKNOWN', detail: truncate(text || 'Could not read login status', 300) };
  }

  async startLogin(): Promise<LoginFlow> {
    return {
      command: await this.requireBinary(),
      args: ['login'],
      hint: 'Sign in with ChatGPT in the browser window that opens (or open the printed URL).',
    };
  }

  async logout(): Promise<void> {
    await this.exec(await this.requireBinary(), ['logout']);
  }
}
