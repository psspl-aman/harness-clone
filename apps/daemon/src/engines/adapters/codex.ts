import type { AgentEvent } from '@ai-harness/shared';
import { classifyEngineError } from '../errors';
import {
  CliAdapter,
  num,
  truncate,
  withSystemPrompt,
  type BuiltCommand,
  type RunState,
} from '../cli-adapter';
import type { AgentRunInput, AuthStatusResult, LoginFlow } from '../types';

type Json = Record<string, unknown>;

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
    switch (d.type) {
      case 'thread.started':
        out.push({ kind: 'session', sessionId: String(d.thread_id) });
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

  async getAuthStatus(): Promise<AuthStatusResult> {
    if (this.env.apiKey())
      return {
        status: 'ACTIVE',
        accountLabel: 'API key',
        detail: 'Using the OpenAI API key stored in AI Harness',
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
