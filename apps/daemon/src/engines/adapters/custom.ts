import type { AgentEvent, CustomEngineConfig } from '@agentforge/shared';
import { classifyEngineError } from '../errors';
import {
  CliAdapter,
  getPath,
  num,
  truncate,
  withSystemPrompt,
  type BuiltCommand,
  type RunState,
} from '../cli-adapter';
import type { AdapterEnv, AgentRunInput, AuthStatusResult, LoginFlow } from '../types';

/**
 * Expand an argument template. An argument that is exactly one placeholder
 * resolving to "" is dropped together with a preceding `-flag`.
 */
export function expandArgs(template: string[], vars: Record<string, string>): string[] {
  const out: string[] = [];
  for (const arg of template) {
    const only = arg.match(/^\{\{(\w+)\}\}$/);
    if (only && !vars[only[1]!]) {
      if (out.length && out[out.length - 1]!.startsWith('-')) out.pop();
      continue;
    }
    out.push(arg.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? ''));
  }
  return out;
}

/** User-defined CLI engine configured from the UI (no shell involved). */
export class CustomCliAdapter extends CliAdapter {
  readonly description: string;
  readonly installGuideUrl = null;
  readonly installCommand = null;
  readonly capabilities;

  constructor(
    readonly id: string,
    readonly displayName: string,
    private readonly config: CustomEngineConfig,
    env: AdapterEnv,
  ) {
    super(env);
    this.description = `Custom CLI: ${config.command}`;
    this.versionArgs = config.versionArgs ?? ['--version'];
    this.apiKeyEnvVar = config.apiKeyEnv ?? null;
    this.capabilities = {
      login: !!config.loginArgs,
      logout: false,
      apiKey: !!config.apiKeyEnv,
      resume: config.args.some((a) => a.includes('{{sessionId}}')),
      modelList: false,
    };
  }

  protected binaryCandidates(): string[] {
    return [this.config.command];
  }

  protected buildCommand(input: AgentRunInput): BuiltCommand {
    const prompt = withSystemPrompt(input.prompt, input.systemPrompt);
    const vars = {
      prompt: this.config.promptVia === 'arg' ? prompt : '',
      cwd: input.cwd,
      model: input.model ?? '',
      sessionId: input.resumeSessionId ?? '',
    };
    return {
      args: expandArgs(this.config.args, vars),
      stdin: this.config.promptVia === 'stdin' ? prompt : undefined,
    };
  }

  protected parseLine(line: string, state: RunState): AgentEvent[] {
    const c = this.config;
    if (c.outputFormat === 'text') {
      const out: AgentEvent[] = [{ kind: 'text', text: line }];
      if (c.usage?.regex) {
        const m = line.match(new RegExp(c.usage.regex));
        if (m?.groups)
          out.push({
            kind: 'usage',
            usage: {
              inputTokens: num(Number(m.groups.input)),
              outputTokens: num(Number(m.groups.output)),
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          });
      }
      return out;
    }
    let d: unknown;
    try {
      d = JSON.parse(line);
    } catch {
      return [{ kind: 'log', stream: 'stdout', line: truncate(line, 4000) }];
    }
    const out: AgentEvent[] = [];
    const sid = getPath(d, c.sessionIdPath);
    if (typeof sid === 'string' && sid && sid !== state.sessionId)
      out.push({ kind: 'session', sessionId: sid });
    const text = getPath(d, c.textPath);
    if (typeof text === 'string' && text) out.push({ kind: 'text', text });
    const inTok = getPath(d, c.usage?.inputTokensPath);
    const outTok = getPath(d, c.usage?.outputTokensPath);
    if (typeof inTok === 'number' || typeof outTok === 'number') {
      out.push({
        kind: 'usage',
        usage: {
          inputTokens: num(inTok),
          outputTokens: num(outTok),
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      });
    }
    return out;
  }

  async getAuthStatus(): Promise<AuthStatusResult> {
    const bin = await this.requireBinary();
    if (this.env.apiKey()) return { status: 'ACTIVE', accountLabel: 'API key' };
    if (!this.config.authCheckArgs)
      return { status: 'UNKNOWN', detail: 'No auth check configured' };
    const r = await this.exec(bin, this.config.authCheckArgs);
    if (r.exitCode === 0)
      return { status: 'ACTIVE', detail: truncate(r.stdout.trim().split('\n')[0] ?? '', 200) };
    const e = classifyEngineError(`${r.stdout}\n${r.stderr}`);
    return {
      status: e.kind === 'QUOTA_EXPIRED' ? 'QUOTA_EXHAUSTED' : 'LOGGED_OUT',
      detail: e.message,
    };
  }

  async startLogin(): Promise<LoginFlow> {
    if (!this.config.loginArgs) throw new Error('No login command configured for this engine');
    return {
      command: await this.requireBinary(),
      args: this.config.loginArgs,
      hint: 'Complete the login in the terminal below.',
    };
  }

  async logout(): Promise<void> {
    throw new Error('Custom engines have no logout command');
  }
}
