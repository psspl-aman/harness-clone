import type { AgentEvent } from '@ai-harness/shared';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { classifyEngineError } from '../errors';
import {
  assertArgPromptSize,
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
 * Google Gemini CLI (`gemini -o stream-json`). Event contract from
 * gemini-cli packages/core/src/output/types.ts: init{session_id,model},
 * message{role,content,delta}, tool_use, tool_result, error{severity},
 * result{status,error,stats}. There is no auth-status command: an API key or
 * a cached Google sign-in counts as signed in.
 */
export class GeminiCliAdapter extends CliAdapter {
  readonly id = 'gemini-cli';
  readonly displayName = 'Gemini CLI';
  readonly description =
    'Google’s open-source Gemini agent CLI. Sign in with Google or use a Gemini API key.';
  readonly installGuideUrl = 'https://geminicli.com/docs/get-started/installation/';
  readonly installCommand = 'npm install -g @google/gemini-cli';
  readonly capabilities = {
    login: true,
    logout: false,
    apiKey: true,
    resume: true,
    modelList: false,
    effort: false,
  };
  override readonly staticModels = [
    { id: 'auto', label: 'Auto' },
    { id: 'pro', label: 'Pro' },
    { id: 'flash', label: 'Flash' },
    { id: 'flash-lite', label: 'Flash Lite' },
  ];
  protected override apiKeyEnvVar = 'GEMINI_API_KEY';

  protected binaryCandidates(): string[] {
    return ['gemini'];
  }

  protected buildCommand(input: AgentRunInput): BuiltCommand {
    const prompt = withSystemPrompt(input.prompt, input.systemPrompt);
    assertArgPromptSize(prompt, this.displayName);
    const mode =
      input.permission === 'readonly' ? 'plan' : input.permission === 'edit' ? 'auto_edit' : 'yolo';
    const args = ['-o', 'stream-json', '--approval-mode', mode];
    if (input.model) args.push('-m', input.model);
    if (input.resumeSessionId) args.push('-r', input.resumeSessionId);
    args.push('-p', prompt);
    return { args };
  }

  protected parseLine(line: string, state: RunState): AgentEvent[] {
    const d = JSON.parse(line) as Json;
    switch (d.type) {
      case 'init':
        return [
          {
            kind: 'session',
            sessionId: String(d.session_id),
            model: d.model ? String(d.model) : undefined,
          },
        ];
      case 'message':
        return d.role === 'assistant'
          ? [{ kind: 'text', text: String(d.content ?? ''), delta: d.delta === true }]
          : [];
      case 'tool_use':
        return [
          {
            kind: 'tool_call',
            id: String(d.tool_id),
            name: String(d.tool_name),
            input: d.parameters,
          },
        ];
      case 'tool_result': {
        const err = d.error as Json | undefined;
        return [
          {
            kind: 'tool_result',
            id: String(d.tool_id),
            ok: d.status === 'success',
            output: truncate(String(d.output ?? err?.message ?? '')),
          },
        ];
      }
      case 'error':
        return [{ kind: 'error', message: String(d.message ?? ''), fatal: d.severity === 'error' }];
      case 'result': {
        const out: AgentEvent[] = [];
        const s = d.stats as Json | undefined;
        if (s) {
          const cached = num(s.cached);
          out.push({
            kind: 'usage',
            usage: {
              inputTokens:
                typeof s.input === 'number' ? s.input : Math.max(0, num(s.input_tokens) - cached),
              outputTokens: num(s.output_tokens),
              cacheReadTokens: cached,
              cacheWriteTokens: 0,
              model: Object.keys((s.models ?? {}) as Json)[0],
            },
          });
        }
        if (d.status === 'success') state.succeeded = true;
        else {
          state.succeeded = false;
          state.error = classifyEngineError(
            String(((d.error ?? {}) as Json).message ?? 'Gemini CLI reported an error'),
          );
        }
        return out;
      }
      default:
        return [];
    }
  }

  async getAuthStatus(): Promise<AuthStatusResult> {
    await this.requireBinary();
    if (this.env.apiKey())
      return {
        status: 'ACTIVE',
        accountLabel: 'API key',
        detail: 'Using the Gemini API key stored in AI Harness',
      };
    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)
      return {
        status: 'ACTIVE',
        accountLabel: 'API key (environment)',
        detail: 'GEMINI_API_KEY is set in the daemon’s environment',
      };
    if (existsSync(join(homedir(), '.gemini', 'oauth_creds.json')))
      return { status: 'ACTIVE', accountLabel: 'Google account', detail: 'Cached Google sign-in' };
    return {
      status: 'LOGGED_OUT',
      detail: 'Sign in with Google via Login, or add a Gemini API key',
    };
  }

  async startLogin(): Promise<LoginFlow> {
    return {
      command: await this.requireBinary(),
      args: [],
      hint: 'Choose “Sign in with Google” when prompted and finish in the browser. Type /quit when you’re done.',
    };
  }

  async logout(): Promise<void> {
    throw new Error(
      'Gemini CLI has no logout command — remove the stored API key or sign out from inside the CLI',
    );
  }
}
