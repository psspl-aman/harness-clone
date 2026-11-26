import type { AgentEvent, UsageWindow } from '@ai-harness/shared';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { newestExtensionBinary } from '../binary';
import { classifyEngineError } from '../errors';
import { gitBashPath } from '../../lib/platform';
import { AGENT_TOOLS_SERVER } from '../../lib/product';
import { CliAdapter, num, truncate, type BuiltCommand, type RunState } from '../cli-adapter';
import type { AgentRunInput, AuthStatusResult, LoginFlow } from '../types';

const READONLY_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(ls:*)',
];

type Json = Record<string, unknown>;

/**
 * Claude Code CLI (`claude -p --output-format stream-json --verbose`).
 * Verified against Claude Code 2.1.x: stream events are system/init,
 * rate_limit_event, assistant, user (tool results) and a final result with
 * total cost and per-model usage. Auth via `claude auth status --json`.
 */
export class ClaudeCodeAdapter extends CliAdapter {
  readonly id = 'claude-code';
  readonly displayName = 'Claude Code';
  readonly description =
    'Anthropic’s agentic coding CLI. Uses your Claude subscription or an Anthropic API key.';
  readonly installGuideUrl = 'https://docs.claude.com/en/docs/claude-code/setup';
  readonly installCommand = 'curl -fsSL https://claude.ai/install.sh | bash';
  readonly capabilities = {
    login: true,
    logout: true,
    apiKey: true,
    resume: true,
    modelList: false,
    effort: true,
  };
  override readonly staticModels = [
    { id: 'opus', label: 'Opus (latest)' },
    { id: 'sonnet', label: 'Sonnet (latest)' },
    { id: 'haiku', label: 'Haiku (latest)' },
  ];
  protected override apiKeyEnvVar = 'ANTHROPIC_API_KEY';
  readonly supportsGuard = true;

  protected binaryCandidates(): string[] {
    const h = homedir();
    const ext = newestExtensionBinary(
      [
        join(h, '.vscode/extensions'),
        join(h, '.vscode-server/extensions'),
        join(h, '.cursor/extensions'),
        join(h, '.windsurf/extensions'),
      ],
      'anthropic.claude-code-',
      'resources/native-binary/claude',
    );
    return ['claude', join(h, '.claude/local/claude'), ...(ext ? [ext] : [])];
  }

  protected buildCommand(input: AgentRunInput): BuiltCommand {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (input.model) args.push('--model', input.model);
    // `claude --effort <low|medium|high|xhigh|max>` (Claude Code 2.1.x).
    if (input.effort) args.push('--effort', input.effort);
    if (input.resumeSessionId) args.push('--resume', input.resumeSessionId);
    if (input.systemPrompt) args.push('--append-system-prompt', input.systemPrompt);
    // AI Harness's own MCP tools (project memory, task, errors) for this run.
    const mcp = input.guard?.mcp;
    if (mcp)
      args.push(
        '--mcp-config',
        JSON.stringify({
          mcpServers: { [AGENT_TOOLS_SERVER]: { type: 'http', url: mcp.url, headers: mcp.headers } },
        }),
      );
    const own = mcp ? [`mcp__${AGENT_TOOLS_SERVER}`] : [];
    if (input.permission === 'readonly')
      args.push('--permission-mode', 'dontAsk', '--allowedTools', ...READONLY_TOOLS, ...own);
    else if (input.permission === 'edit')
      args.push(
        '--permission-mode',
        'acceptEdits',
        ...(own.length ? ['--allowedTools', ...own] : []),
      );
    else
      args.push(
        '--permission-mode',
        'acceptEdits',
        '--allowedTools',
        'Bash',
        'Edit',
        'Write',
        'Read',
        'Grep',
        'Glob',
        ...own,
      );
    // Every tool call first asks AI Harness's guard (PreToolUse hook, exit 2 = blocked).
    if (input.guard)
      args.push(
        '--settings',
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: '*',
                hooks: [{ type: 'command', command: input.guard.hookCommand, timeout: 900 }],
              },
            ],
          },
        }),
      );
    // On Windows, Claude Code runs its PreToolUse hooks (AI Harness's safety
    // guard included) and its Bash tool through Git Bash; point it at a detected
    // install so hooks don't fail with "Git Bash wasn't found" and block every
    // tool call. No-op on POSIX and when an install can't be located.
    const env: Record<string, string> = { ...input.guard?.env };
    const bash = gitBashPath();
    if (bash) env.CLAUDE_CODE_GIT_BASH_PATH = bash;
    // Prompt goes through stdin: no argv size limits, nothing visible in `ps`.
    return { args, stdin: input.prompt, env };
  }

  protected parseLine(line: string, state: RunState): AgentEvent[] {
    const d = JSON.parse(line) as Json;
    const out: AgentEvent[] = [];
    switch (d.type) {
      case 'system':
        if (d.subtype === 'init')
          out.push({
            kind: 'session',
            sessionId: String(d.session_id),
            model: d.model ? String(d.model) : undefined,
          });
        break;
      case 'rate_limit_event': {
        const info = (d.rate_limit_info ?? {}) as Json;
        const windows: UsageWindow[] = Object.entries(
          (info.unifiedWindows ?? {}) as Record<string, Json>,
        ).map(([name, w]) => ({
          name,
          utilization: typeof w.utilization === 'number' ? w.utilization : null,
          resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : null,
          status:
            w.status === 'allowed' || w.status === 'rejected'
              ? w.status
              : w.status === 'allowed_warning'
                ? 'warning'
                : 'unknown',
        }));
        const status =
          info.status === 'rejected'
            ? 'rejected'
            : info.status === 'allowed_warning'
              ? 'warning'
              : info.status === 'allowed'
                ? 'allowed'
                : 'unknown';
        const resetsAt = typeof info.resetsAt === 'number' ? info.resetsAt * 1000 : null;
        out.push({ kind: 'rate_limit', status, resetsAt, windows });
        if (status === 'rejected') {
          state.error = {
            kind: 'QUOTA_EXPIRED',
            message: `Usage limit reached (${String(info.rateLimitType ?? 'window')})`,
            resetAt: resetsAt,
          };
        }
        break;
      }
      case 'assistant':
        for (const c of ((d.message as Json)?.content ?? []) as Json[]) {
          if (c.type === 'text') out.push({ kind: 'text', text: String(c.text) });
          else if (c.type === 'thinking')
            out.push({ kind: 'thinking', text: String(c.thinking ?? '') });
          else if (c.type === 'tool_use')
            out.push({ kind: 'tool_call', id: String(c.id), name: String(c.name), input: c.input });
        }
        break;
      case 'user':
        for (const c of ((d.message as Json)?.content ?? []) as Json[]) {
          if (c.type === 'tool_result') {
            const content = typeof c.content === 'string' ? c.content : JSON.stringify(c.content);
            out.push({
              kind: 'tool_result',
              id: String(c.tool_use_id),
              ok: c.is_error !== true,
              output: truncate(content),
            });
          }
        }
        break;
      case 'result': {
        if (d.session_id) state.sessionId = String(d.session_id);
        const modelUsage = (d.modelUsage ?? {}) as Record<string, Json>;
        const models = Object.keys(modelUsage);
        const u = (d.usage ?? {}) as Json;
        out.push({
          kind: 'usage',
          usage: models.length
            ? {
                inputTokens: models.reduce((a, m) => a + num(modelUsage[m]!.inputTokens), 0),
                outputTokens: models.reduce((a, m) => a + num(modelUsage[m]!.outputTokens), 0),
                cacheReadTokens: models.reduce(
                  (a, m) => a + num(modelUsage[m]!.cacheReadInputTokens),
                  0,
                ),
                cacheWriteTokens: models.reduce(
                  (a, m) => a + num(modelUsage[m]!.cacheCreationInputTokens),
                  0,
                ),
                costUsd: num(d.total_cost_usd),
                model: models[0],
              }
            : {
                inputTokens: num(u.input_tokens),
                outputTokens: num(u.output_tokens),
                cacheReadTokens: num(u.cache_read_input_tokens),
                cacheWriteTokens: num(u.cache_creation_input_tokens),
                costUsd: num(d.total_cost_usd),
              },
        });
        const text = typeof d.result === 'string' ? d.result : '';
        if (d.is_error === true || (typeof d.subtype === 'string' && d.subtype !== 'success')) {
          state.succeeded = false;
          const evidence = [
            text,
            // `subtype` is "success" even on is_error results (e.g. a 401) — don't echo it.
            d.subtype !== 'success' ? d.subtype : '',
            d.api_error_status ? `HTTP ${String(d.api_error_status)}` : '',
          ]
            .filter(Boolean)
            .join(' · ');
          state.error ??= classifyEngineError(evidence || 'Claude Code reported an error');
        } else {
          state.succeeded = true;
          state.finalText = text;
        }
        break;
      }
      default:
        break; // hook events and other system notices
    }
    return out;
  }

  async getAuthStatus(): Promise<AuthStatusResult> {
    if (this.env.apiKey())
      return {
        status: 'ACTIVE',
        accountLabel: 'API key',
        detail: 'Using the Anthropic API key stored in AI Harness',
      };
    const bin = await this.requireBinary();
    const r = await this.exec(bin, ['auth', 'status', '--json']);
    let s: Json;
    try {
      s = JSON.parse(r.stdout) as Json;
    } catch {
      return {
        status: 'UNKNOWN',
        detail: truncate(r.stderr || r.stdout || 'Could not read auth status', 300),
      };
    }
    if (s.loggedIn !== true) return { status: 'LOGGED_OUT', detail: 'Not signed in' };
    const expiresAt = typeof s.loginExpiresAt === 'string' ? Date.parse(s.loginExpiresAt) : NaN;
    const plan = [s.authMethod, s.subscriptionType].filter(Boolean).join(' · ');
    const detail = `${plan}${Number.isFinite(expiresAt) ? ` · session valid until ${new Date(expiresAt).toLocaleDateString()}` : ''}`;
    return {
      status: Number.isFinite(expiresAt) && expiresAt < Date.now() ? 'EXPIRED' : 'ACTIVE',
      accountLabel: (s.email as string | undefined) ?? (s.orgName as string | undefined) ?? null,
      detail,
    };
  }

  async startLogin(): Promise<LoginFlow> {
    return {
      command: await this.requireBinary(),
      args: ['auth', 'login'],
      hint: 'Follow the prompts. If a browser does not open, copy the URL into your browser and paste the code back here.',
    };
  }

  async logout(): Promise<void> {
    const r = await this.exec(await this.requireBinary(), ['auth', 'logout']);
    if (r.exitCode !== 0) throw new Error(truncate(r.stderr || r.stdout || 'Logout failed', 300));
  }
}
