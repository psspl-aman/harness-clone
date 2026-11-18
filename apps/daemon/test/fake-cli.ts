import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FakeResponse {
  /** Matches when the joined argv starts with this string ('' matches all). */
  match: string;
  stdout?: string;
  stdoutFile?: string;
  stderr?: string;
  exitCode?: number;
  sleepMs?: number;
  /** Use this response at most once (lets tests script a sequence of runs). */
  once?: boolean;
}

export interface FakeCli {
  path: string;
  setResponses(r: FakeResponse[]): void;
  calls(): {
    args: string[];
    stdin: string;
    cwd: string;
    env: Record<string, string | undefined>;
  }[];
}

export const FIXTURES = join(import.meta.dirname, 'fixtures/engines');

/**
 * A real executable (node script) standing in for an agent CLI. It records
 * every invocation (argv, stdin, cwd, selected env vars) and replays canned
 * stdout/stderr/exit codes chosen by argv prefix.
 */
export function makeFakeCli(dir: string, name: string): FakeCli {
  const path = join(dir, name);
  const cfg = `${path}.json`;
  const log = `${path}.calls.jsonl`;
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require('node:fs');
const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(cfg)}, 'utf8'));
const args = process.argv.slice(2);
let stdin = '';
if (!process.stdin.isTTY) { try { stdin = fs.readFileSync(0, 'utf8'); } catch {} }
const env = {};
for (const k of ['ANTHROPIC_API_KEY', 'CODEX_API_KEY', 'GEMINI_API_KEY', 'MY_CLI_KEY', 'NO_COLOR']) env[k] = process.env[k];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, stdin, cwd: process.cwd(), env }) + '\\n');
const key = args.join(' ');
const usedPath = ${JSON.stringify(cfg)} + '.used';
const used = fs.existsSync(usedPath) ? JSON.parse(fs.readFileSync(usedPath, 'utf8')) : [];
const idx = cfg.findIndex((x, i) => key.startsWith(x.match) && !(x.once && used.includes(i)));
const r = idx >= 0 ? cfg[idx] : { exitCode: 99, stderr: 'fake: no response for ' + key };
if (idx >= 0 && r.once) fs.writeFileSync(usedPath, JSON.stringify([...used, idx]));
(async () => {
  if (r.stdoutFile) process.stdout.write(fs.readFileSync(r.stdoutFile));
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.sleepMs) await new Promise((res) => setTimeout(res, r.sleepMs));
  process.exit(r.exitCode ?? 0);
})();
`,
  );
  chmodSync(path, 0o755);
  writeFileSync(cfg, '[]');
  return {
    path,
    setResponses: (r) => {
      writeFileSync(cfg, JSON.stringify(r));
      rmSync(`${cfg}.used`, { force: true });
    },
    calls: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [],
  };
}

/** A Claude Code stream-json transcript whose final answer is `text`. */
export function claudeStream(
  text: string,
  sessionId = '11111111-2222-3333-4444-555555555555',
): string {
  const lines = [
    { type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-haiku-5-5' },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      session_id: sessionId,
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: text,
      session_id: sessionId,
      total_cost_usd: 0.01,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      modelUsage: {
        'claude-haiku-5-5': {
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadInputTokens: 500,
          cacheCreationInputTokens: 0,
          costUSD: 0.01,
        },
      },
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}
