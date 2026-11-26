import type { AgentEvent } from '@ai-harness/shared';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { classifyEngineError } from '../errors';
import {
  assertArgPromptSize,
  CliAdapter,
  num,
  withSystemPrompt,
  type BuiltCommand,
  type RunState,
} from '../cli-adapter';
import type { AgentRunInput, AuthStatusResult, LoginFlow } from '../types';

type Json = Record<string, unknown>;

/**
 * Google Antigravity CLI (`agy -p … --output-format stream-json`).
 * Verified against agy 1.5.x: events are {event:"init"}, {event:"step_update"}
 * (agent_response text deltas, tool steps, per-step usage) and a final
 * {event:"result"} with status/response/usage. `agy models` doubles as the
 * auth probe and lists available models. Note: the `antigravity` binary on
 * PATH is the IDE launcher, not this CLI.
 */
export class AntigravityAdapter extends CliAdapter {
  readonly id = 'antigravity';
  readonly displayName = 'Antigravity';
  readonly description =
    'Google Antigravity agent CLI (agy). Signs in with your Google account; offers Gemini and partner models.';
  readonly installGuideUrl = 'https://antigravity.google/download';
  readonly installCommand = null;
  readonly capabilities = {
    login: true,
    logout: false,
    apiKey: false,
    resume: true,
    modelList: true,
    effort: false,
  };

  protected binaryCandidates(): string[] {
    return ['agy', join(homedir(), '.local/bin/agy')];
  }

  protected buildCommand(input: AgentRunInput): BuiltCommand {
    const prompt = withSystemPrompt(input.prompt, input.systemPrompt);
    assertArgPromptSize(prompt, this.displayName);
    const mode =
      input.permission === 'readonly'
        ? 'plan'
        : input.permission === 'edit'
          ? 'accept-edits'
          : 'auto';
    const args = ['-p', prompt, '--output-format', 'stream-json', '--mode', mode];
    if (input.model) args.push('--model', input.model);
    if (input.resumeSessionId) args.push('--conversation', input.resumeSessionId);
    return { args };
  }

  protected parseLine(line: string, state: RunState): AgentEvent[] {
    const d = JSON.parse(line) as Json;
    if (d.event === 'init') {
      const init = (d.init ?? {}) as Json;
      return [
        {
          kind: 'session',
          sessionId: String(d.conversation_id),
          model: init.model ? String(init.model) : undefined,
        },
      ];
    }
    if (d.event === 'step_update') {
      const s = (d.step_update ?? {}) as Json;
      const id = `${String(s.step_index)}`;
      if (s.step_type === 'agent_response' && typeof s.text_delta === 'string')
        return [{ kind: 'text', text: s.text_delta, delta: true }];
      if (s.step_type === 'tool') {
        const info = (s.tool_info ?? {}) as Json;
        if (s.state === 'ACTIVE')
          return [
            {
              kind: 'tool_call',
              id,
              name: String(s.tool_name ?? info.name),
              input: info.parameters,
            },
          ];
        if (s.state === 'DONE') return [{ kind: 'tool_result', id, ok: true }];
        if (s.state === 'ERROR' || s.state === 'FAILED' || s.state === 'CANCELED')
          return [{ kind: 'tool_result', id, ok: false, output: String(s.error ?? s.state) }];
      }
      return [];
    }
    if (d.event === 'result') {
      const r = (d.result ?? {}) as Json;
      const u = (r.usage ?? {}) as Json;
      if (r.conversation_id) state.sessionId = String(r.conversation_id);
      if (r.status === 'SUCCESS') {
        state.succeeded = true;
        if (typeof r.response === 'string') state.finalText = r.response.trim();
      } else {
        state.succeeded = false;
        state.error = classifyEngineError(
          String(r.error ?? r.response ?? `Antigravity finished with status ${String(r.status)}`),
        );
      }
      return [
        {
          kind: 'usage',
          usage: {
            inputTokens: num(u.input_tokens),
            outputTokens: num(u.output_tokens) + num(u.thinking_tokens),
            cacheReadTokens: num(u.cache_read_tokens),
            cacheWriteTokens: 0,
          },
        },
      ];
    }
    if (d.event === 'error') {
      state.error = classifyEngineError(String(d.message ?? d.error ?? 'Antigravity error'));
      return [{ kind: 'error', message: String(d.message ?? d.error ?? ''), fatal: true }];
    }
    return [];
  }

  async getAuthStatus(): Promise<AuthStatusResult> {
    const r = await this.exec(await this.requireBinary(), ['models'], 30_000);
    const models = r.stdout
      .split('\n')
      .map((l) => l.split('\t'))
      .filter((p) => p.length >= 2 && p[0]!.trim())
      .map(([id, label]) => ({ id: id!.trim(), label: label!.trim() }));
    if (r.exitCode === 0 && models.length)
      return {
        status: 'ACTIVE',
        accountLabel: 'Google account',
        detail: `${models.length} models available`,
        models,
      };
    const text = `${r.stdout}\n${r.stderr}`.trim();
    if (r.timedOut) return { status: 'UNKNOWN', detail: 'Timed out checking sign-in' };
    const e = classifyEngineError(text);
    if (e.kind === 'AUTH_EXPIRED') return { status: 'LOGGED_OUT', detail: e.message };
    if (e.kind === 'QUOTA_EXPIRED' || e.kind === 'RATE_LIMIT')
      return { status: 'QUOTA_EXHAUSTED', detail: e.message, resetAt: e.resetAt };
    return { status: 'UNKNOWN', detail: e.message };
  }

  async startLogin(): Promise<LoginFlow> {
    return {
      command: await this.requireBinary(),
      args: [],
      hint: 'Antigravity asks you to sign in with Google on first launch. Finish in the browser, then type /exit.',
    };
  }

  async logout(): Promise<void> {
    throw new Error('The Antigravity CLI has no logout command — sign out from inside agy');
  }
}
