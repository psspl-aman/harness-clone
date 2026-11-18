import type { AgentEvent } from '@agentforge/shared';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AntigravityAdapter } from '../src/engines/adapters/antigravity';
import { ClaudeCodeAdapter } from '../src/engines/adapters/claude-code';
import { CodexAdapter } from '../src/engines/adapters/codex';
import { CustomCliAdapter } from '../src/engines/adapters/custom';
import { GeminiCliAdapter } from '../src/engines/adapters/gemini-cli';
import type { AdapterEnv, AgentEngineAdapter, AgentRunInput } from '../src/engines/types';
import { FIXTURES, makeFakeCli, type FakeCli } from './fake-cli';
import { tempDir } from './helpers';

let dir: string;
let fake: FakeCli;
let apiKey: string | null;
beforeEach(() => {
  dir = tempDir('af-engines-');
  fake = makeFakeCli(dir, 'cli');
  apiKey = null;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const env = (): AdapterEnv => ({ binaryOverride: () => fake.path, apiKey: () => apiKey });
const input = (o: Partial<AgentRunInput> = {}): AgentRunInput => ({
  prompt: 'Create hello.txt',
  cwd: dir,
  permission: 'edit',
  ...o,
});
async function run(adapter: AgentEngineAdapter, o: Partial<AgentRunInput> = {}) {
  const events: AgentEvent[] = [];
  const result = await adapter.run(input(o), (e) => events.push(e));
  return { result, events, kinds: events.map((e) => e.kind) };
}

describe('Claude Code adapter', () => {
  it('parses a real stream-json run (session, tools, text, usage, cost)', async () => {
    fake.setResponses([{ match: '-p', stdoutFile: join(FIXTURES, 'claude-success.jsonl') }]);
    const { result, events, kinds } = await run(new ClaudeCodeAdapter(env()), {
      model: 'haiku',
      systemPrompt: 'Be terse',
    });
    expect(result).toMatchObject({
      status: 'succeeded',
      finalText: 'DONE',
      exitCode: 0,
      error: null,
    });
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(kinds).toEqual(['session', 'rate_limit', 'tool_call', 'tool_result', 'text', 'usage']);
    expect(events.find((e) => e.kind === 'tool_call')).toMatchObject({ name: 'Bash' });
    expect(result.usage).toMatchObject({
      inputTokens: 1195,
      outputTokens: 196,
      cacheReadTokens: 72781,
      cacheWriteTokens: 24862,
      model: 'claude-haiku-5-5',
    });
    expect(result.usage.costUsd).toBeCloseTo(0.0059, 3);
    const rl = events.find((e) => e.kind === 'rate_limit');
    expect(rl).toMatchObject({
      status: 'allowed',
      windows: [
        { name: 'five_hour', utilization: 0.43, resetsAt: 1795014000_000 },
        { name: 'seven_day' },
      ],
    });

    const [call] = fake.calls();
    expect(call!.stdin).toBe('Create hello.txt'); // prompt via stdin, not argv
    expect(call!.args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'haiku',
      '--append-system-prompt',
      'Be terse',
      '--permission-mode',
      'acceptEdits',
    ]);
    expect(call!.cwd).toBe(dir);
  });

  it('maps permission profiles and resume', async () => {
    fake.setResponses([{ match: '-p', stdoutFile: join(FIXTURES, 'claude-success.jsonl') }]);
    const a = new ClaudeCodeAdapter(env());
    await run(a, { permission: 'readonly', resumeSessionId: 'abc' });
    await run(a, { permission: 'full' });
    const [ro, full] = fake.calls();
    expect(ro!.args).toEqual(
      expect.arrayContaining([
        '--resume',
        'abc',
        '--permission-mode',
        'dontAsk',
        '--allowedTools',
        'Read',
        'Bash(git diff:*)',
      ]),
    );
    expect(ro!.args).not.toContain('Edit');
    expect(full!.args).toEqual(
      expect.arrayContaining([
        '--permission-mode',
        'acceptEdits',
        '--allowedTools',
        'Bash',
        'Edit',
      ]),
    );
  });

  it('reports a usage-limit failure with the reset time', async () => {
    fake.setResponses([
      { match: '-p', stdoutFile: join(FIXTURES, 'claude-limit.jsonl'), exitCode: 1 },
    ]);
    const { result } = await run(new ClaudeCodeAdapter(env()));
    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({ kind: 'QUOTA_EXPIRED', resetAt: 1795014000_000 });
  });

  it('classifies an auth failure', async () => {
    fake.setResponses([
      { match: '-p', stdoutFile: join(FIXTURES, 'claude-auth.jsonl'), exitCode: 1 },
    ]);
    const { result } = await run(new ClaudeCodeAdapter(env()));
    expect(result.error?.kind).toBe('AUTH_EXPIRED');
  });

  it('reads auth status JSON (active, expired, logged out) and passes the API key via env', async () => {
    const a = new ClaudeCodeAdapter(env());
    fake.setResponses([
      {
        match: 'auth status',
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          subscriptionType: 'team',
          email: 'dev@example.com',
          loginExpiresAt: '2099-01-01T00:00:00Z',
        }),
      },
    ]);
    expect(await a.getAuthStatus()).toMatchObject({
      status: 'ACTIVE',
      accountLabel: 'dev@example.com',
    });
    fake.setResponses([
      {
        match: 'auth status',
        stdout: JSON.stringify({ loggedIn: true, loginExpiresAt: '2001-01-01T00:00:00Z' }),
      },
    ]);
    expect((await a.getAuthStatus()).status).toBe('EXPIRED');
    fake.setResponses([{ match: 'auth status', stdout: JSON.stringify({ loggedIn: false }) }]);
    expect((await a.getAuthStatus()).status).toBe('LOGGED_OUT');
    fake.setResponses([{ match: 'auth status', stdout: 'garbage', exitCode: 1 }]);
    expect((await a.getAuthStatus()).status).toBe('UNKNOWN');

    apiKey = 'sk-ant-test-0000000000'; // gforge:allow — fake test key
    expect((await a.getAuthStatus()).status).toBe('ACTIVE');
    fake.setResponses([{ match: '-p', stdoutFile: join(FIXTURES, 'claude-success.jsonl') }]);
    await run(a);
    expect(fake.calls().at(-1)!.env.ANTHROPIC_API_KEY).toBe('sk-ant-test-0000000000'); // gforge:allow — fake test key
  });

  it('builds the login flow and detects the version', async () => {
    fake.setResponses([{ match: '--version', stdout: '2.1.327 (Claude Code)\n' }]);
    const a = new ClaudeCodeAdapter(env());
    expect(await a.detectInstalled()).toEqual({
      installed: true,
      path: fake.path,
      version: '2.1.327',
    });
    expect(await a.startLogin()).toMatchObject({ command: fake.path, args: ['auth', 'login'] });
  });
});

describe('Codex adapter', () => {
  it('parses exec --json events (contract fixture)', async () => {
    fake.setResponses([{ match: 'exec', stdoutFile: join(FIXTURES, 'codex-success.jsonl') }]);
    const { result, events } = await run(new CodexAdapter(env()), {
      model: 'gpt-5-codex',
      systemPrompt: 'Rules',
    });
    expect(result).toMatchObject({
      status: 'succeeded',
      sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53',
      finalText: 'DONE',
    });
    expect(result.usage).toEqual({
      inputTokens: 315,
      outputTokens: 186,
      cacheReadTokens: 24448,
      cacheWriteTokens: 0,
    });
    expect(
      events.filter((e) => e.kind === 'tool_call').map((e) => (e as { name: string }).name),
    ).toEqual(['shell', 'file_change']);
    const [call] = fake.calls();
    expect(call!.args).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-C',
      dir,
      '-m',
      'gpt-5-codex',
      '--sandbox',
      'workspace-write',
      '-',
    ]);
    expect(call!.stdin).toContain('<system_instructions>\nRules');
    expect(call!.stdin).toContain('Create hello.txt');
  });

  it('maps turn.failed with a relative reset time', async () => {
    fake.setResponses([
      { match: 'exec', stdoutFile: join(FIXTURES, 'codex-limit.jsonl'), exitCode: 1 },
    ]);
    const before = Date.now();
    const { result } = await run(new CodexAdapter(env()), {
      resumeSessionId: 'thread-1',
      permission: 'readonly',
    });
    expect(result.error?.kind).toBe('QUOTA_EXPIRED');
    expect(result.error!.resetAt! - before).toBeGreaterThanOrEqual(
      2 * 3600_000 + 5 * 60_000 - 1000,
    );
    expect(fake.calls()[0]!.args).toEqual(
      expect.arrayContaining(['--sandbox', 'read-only', 'resume', 'thread-1', '-']),
    );
  });

  it('reads `codex login status`', async () => {
    const a = new CodexAdapter(env());
    fake.setResponses([{ match: 'login status', stdout: 'Logged in using ChatGPT\n' }]);
    expect(await a.getAuthStatus()).toMatchObject({ status: 'ACTIVE', accountLabel: 'ChatGPT' });
    fake.setResponses([{ match: 'login status', stderr: 'Not logged in\n', exitCode: 1 }]);
    expect((await a.getAuthStatus()).status).toBe('LOGGED_OUT');
  });
});

describe('Gemini CLI adapter', () => {
  it('parses stream-json events (contract fixture)', async () => {
    fake.setResponses([{ match: '-o', stdoutFile: join(FIXTURES, 'gemini-success.jsonl') }]);
    const { result, events } = await run(new GeminiCliAdapter(env()), {
      model: 'flash',
      permission: 'full',
    });
    expect(result).toMatchObject({
      status: 'succeeded',
      sessionId: 'c2a7e3f1-5b1d-4c0e-9a51-0e7c2f8a1d44',
      finalText: 'DONE',
    });
    expect(result.usage).toMatchObject({
      inputTokens: 3000,
      outputTokens: 120,
      cacheReadTokens: 6000,
      model: 'gemini-2.5-pro',
    });
    expect(events.find((e) => e.kind === 'tool_result')).toMatchObject({ ok: true });
    expect(fake.calls()[0]!.args).toEqual([
      '-o',
      'stream-json',
      '--approval-mode',
      'yolo',
      '-m',
      'flash',
      '-p',
      'Create hello.txt',
    ]);
  });

  it('classifies a 429 quota error with retry delay', async () => {
    fake.setResponses([
      { match: '-o', stdoutFile: join(FIXTURES, 'gemini-limit.jsonl'), exitCode: 1 },
    ]);
    const { result } = await run(new GeminiCliAdapter(env()));
    expect(result.error?.kind).toBe('QUOTA_EXPIRED');
    expect(result.error?.resetAt).not.toBeNull();
  });
});

describe('Antigravity adapter', () => {
  it('parses a real agy stream-json run', async () => {
    fake.setResponses([{ match: '-p', stdoutFile: join(FIXTURES, 'agy-success.jsonl') }]);
    const { result, events } = await run(new AntigravityAdapter(env()), {
      permission: 'readonly',
      resumeSessionId: 'conv-1',
    });
    expect(result).toMatchObject({
      status: 'succeeded',
      sessionId: '3ee54efa-a928-4293-b04e-1311d3938b4e',
      finalText: 'DONE',
    });
    expect(result.usage).toMatchObject({
      inputTokens: 11088,
      outputTokens: 95,
      cacheReadTokens: 6836,
    });
    expect(events.find((e) => e.kind === 'tool_call')).toMatchObject({ name: 'write_file' });
    expect(fake.calls()[0]!.args).toEqual([
      '-p',
      'Create hello.txt',
      '--output-format',
      'stream-json',
      '--mode',
      'plan',
      '--conversation',
      'conv-1',
    ]);
  });

  it('uses `agy models` as the auth probe and model list', async () => {
    const a = new AntigravityAdapter(env());
    fake.setResponses([
      {
        match: 'models',
        stdout:
          'Fetching available models...\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n',
      },
    ]);
    expect(await a.getAuthStatus()).toMatchObject({
      status: 'ACTIVE',
      models: [
        { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
        { id: 'claude-sonnet-4-6' },
      ],
    });
    fake.setResponses([
      { match: 'models', stderr: 'Error: not signed in. Please log in.', exitCode: 1 },
    ]);
    expect((await a.getAuthStatus()).status).toBe('LOGGED_OUT');
    await expect(a.logout()).rejects.toThrow(/no logout/);
  });
});

describe('custom CLI adapter', () => {
  it('runs a JSONL CLI with configured paths and arg template', async () => {
    fake.setResponses([
      {
        match: 'ask',
        stdout:
          '{"sid":"s1","out":{"text":"hello"},"u":{"in":10,"out":3}}\nnot json\n{"out":{"text":"world"}}\n',
      },
    ]);
    const a = new CustomCliAdapter(
      'custom:mine',
      'Mine',
      {
        command: fake.path,
        args: ['ask', '--model', '{{model}}', '{{prompt}}'],
        promptVia: 'arg',
        outputFormat: 'jsonl',
        textPath: 'out.text',
        sessionIdPath: 'sid',
        usage: { inputTokensPath: 'u.in', outputTokensPath: 'u.out' },
        apiKeyEnv: 'MY_CLI_KEY',
      },
      env(),
    );
    apiKey = 'k-123456789'; // gforge:allow — fake test key
    const { result, kinds } = await run(a);
    expect(result).toMatchObject({
      status: 'succeeded',
      sessionId: 's1',
      finalText: 'hello\nworld',
      usage: { inputTokens: 10, outputTokens: 3 },
    });
    expect(kinds).toEqual(['session', 'text', 'usage', 'log', 'text']);
    expect(fake.calls()[0]!.args).toEqual(['ask', 'Create hello.txt']);
    expect(fake.calls()[0]!.env.MY_CLI_KEY).toBe('k-123456789');
  });

  it('runs a text CLI with the prompt on stdin and a usage regex', async () => {
    fake.setResponses([{ match: '', stdout: 'Working...\ntokens in=12 out=4\n' }]);
    const a = new CustomCliAdapter(
      'custom:t',
      'T',
      {
        command: fake.path,
        args: [],
        promptVia: 'stdin',
        outputFormat: 'text',
        usage: { regex: 'in=(?<input>\\d+) out=(?<output>\\d+)' },
      },
      env(),
    );
    const { result } = await run(a);
    expect(result.usage).toMatchObject({ inputTokens: 12, outputTokens: 4 });
    expect(fake.calls()[0]!.stdin).toBe('Create hello.txt');
  });
});

describe('run lifecycle', () => {
  it('fails cleanly when the CLI is missing', async () => {
    const a = new ClaudeCodeAdapter({
      binaryOverride: () => join(dir, 'missing'),
      apiKey: () => null,
    });
    const { result } = await run(a);
    expect(result).toMatchObject({
      status: 'failed',
      error: { kind: 'TOOL_ERROR', message: 'Claude Code is not installed' },
    });
    expect(await a.detectInstalled()).toEqual({ installed: false });
  });

  it('can be cancelled', async () => {
    fake.setResponses([
      {
        match: '-p',
        stdout: '{"type":"system","subtype":"init","session_id":"s"}\n',
        sleepMs: 10_000,
      },
    ]);
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 300);
    const { result } = await run(new ClaudeCodeAdapter(env()), { signal: controller.signal });
    expect(result.status).toBe('cancelled');
    expect(result.sessionId).toBe('s');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('times out', async () => {
    fake.setResponses([{ match: '-p', sleepMs: 10_000 }]);
    const { result } = await run(new ClaudeCodeAdapter(env()), { timeoutMs: 300 });
    expect(result).toMatchObject({ status: 'failed', error: { message: 'Timed out after 0s' } });
  });

  it('treats a non-zero exit without a result as a failure, classified from stderr', async () => {
    fake.setResponses([
      { match: '-p', stderr: 'Error: getaddrinfo ENOTFOUND api.anthropic.com\n', exitCode: 1 },
    ]);
    const { result, events } = await run(new ClaudeCodeAdapter(env()));
    expect(result).toMatchObject({ status: 'failed', exitCode: 1, error: { kind: 'NETWORK' } });
    expect(events.some((e) => e.kind === 'log' && e.stream === 'stderr')).toBe(true);
  });
});
