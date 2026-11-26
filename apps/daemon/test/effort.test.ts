import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/engines/adapters/claude-code';
import { CodexAdapter } from '../src/engines/adapters/codex';
import { GeminiCliAdapter } from '../src/engines/adapters/gemini-cli';
import type { AdapterEnv, AgentEngineAdapter, AgentRunInput } from '../src/engines/types';
import { FIXTURES, makeFakeCli, type FakeCli } from './fake-cli';
import { tempDir } from './helpers';

// Reasoning effort is passed with each CLI's real flag:
//   claude --effort <level>               (claude --help, Claude Code 2.1.x)
//   codex exec -c model_reasoning_effort="<level>"   (codex exec --help: -c key=value, TOML)
let dir: string;
let fake: FakeCli;
beforeEach(() => {
  dir = tempDir('af-effort-');
  fake = makeFakeCli(dir, 'cli');
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const env = (): AdapterEnv => ({ binaryOverride: () => fake.path, apiKey: () => null });
const run = (a: AgentEngineAdapter, o: Partial<AgentRunInput>) =>
  a.run({ prompt: 'hi', cwd: dir, permission: 'edit', ...o }, () => {});

describe('reasoning effort', () => {
  it('Claude Code passes --effort, and nothing when unset', async () => {
    fake.setResponses([{ match: '-p', stdoutFile: join(FIXTURES, 'claude-success.jsonl') }]);
    const a = new ClaudeCodeAdapter(env());
    expect(a.capabilities.effort).toBe(true);
    await run(a, { effort: 'low', model: 'haiku' });
    await run(a, { effort: null });
    const [low, none] = fake.calls();
    expect(low!.args).toEqual(expect.arrayContaining(['--model', 'haiku', '--effort', 'low']));
    expect(none!.args).not.toContain('--effort');
  });

  it('Codex passes -c model_reasoning_effort before the prompt', async () => {
    fake.setResponses([{ match: 'exec', stdoutFile: join(FIXTURES, 'codex-success.jsonl') }]);
    const a = new CodexAdapter(env());
    expect(a.capabilities.effort).toBe(true);
    await run(a, { effort: 'high' });
    await run(a, {});
    const [high, none] = fake.calls();
    const i = high!.args.indexOf('-c');
    expect(high!.args[i + 1]).toBe('model_reasoning_effort="high"');
    expect(high!.args.at(-1)).toBe('-');
    expect(none!.args.join(' ')).not.toContain('model_reasoning_effort');
  });

  it('Codex clamps the Claude-only xhigh/max down to high', async () => {
    fake.setResponses([{ match: 'exec', stdoutFile: join(FIXTURES, 'codex-success.jsonl') }]);
    const a = new CodexAdapter(env());
    await run(a, { effort: 'xhigh' });
    await run(a, { effort: 'max' });
    const [xhigh, max] = fake.calls();
    expect(xhigh!.args[xhigh!.args.indexOf('-c') + 1]).toBe('model_reasoning_effort="high"');
    expect(max!.args[max!.args.indexOf('-c') + 1]).toBe('model_reasoning_effort="high"');
  });

  it('Claude Code passes xhigh/max through unchanged', async () => {
    fake.setResponses([{ match: '-p', stdoutFile: join(FIXTURES, 'claude-success.jsonl') }]);
    const a = new ClaudeCodeAdapter(env());
    await run(a, { effort: 'xhigh' });
    await run(a, { effort: 'max' });
    const [xhigh, max] = fake.calls();
    expect(xhigh!.args).toEqual(expect.arrayContaining(['--effort', 'xhigh']));
    expect(max!.args).toEqual(expect.arrayContaining(['--effort', 'max']));
  });

  it('engines without an effort setting advertise it and ignore it', async () => {
    fake.setResponses([{ match: '', stdoutFile: join(FIXTURES, 'gemini-success.jsonl') }]);
    const a = new GeminiCliAdapter(env());
    expect(a.capabilities.effort).toBe(false);
    await run(a, { effort: 'low' });
    expect(fake.calls()[0]!.args.join(' ')).not.toMatch(/effort/);
  });
});
