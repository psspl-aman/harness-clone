#!/usr/bin/env node
// A fake Claude Code that honours `--settings` PreToolUse hooks: for each line
// "RUN: <command>" in the prompt it runs the configured hook with a Bash tool
// call, then reports {command, exit, stderr} for each as its final answer.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('2.1.328 (Claude Code)\n');
  process.exit(0);
}
if (args[0] === 'auth') {
  process.stdout.write(
    JSON.stringify({ loggedIn: true, loginExpiresAt: '2099-01-01T00:00:00Z' }) + '\n',
  );
  process.exit(0);
}
const prompt = readFileSync(0, 'utf8');
const i = args.indexOf('--settings');
const settings = i >= 0 ? JSON.parse(args[i + 1]) : {};
const hook = settings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command;
const results = [];
for (const line of prompt.split('\n')) {
  const m = line.match(/^RUN: (.*)$/);
  if (!m) continue;
  if (!hook) {
    results.push({ command: m[1], exit: 0, stderr: 'no hook' });
    continue;
  }
  const r = spawnSync('sh', ['-c', hook], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: m[1] },
      cwd: process.cwd(),
    }),
    encoding: 'utf8',
  });
  results.push({ command: m[1], exit: r.status, stderr: r.stderr.trim() });
}
const sid = '22222222-3333-4444-5555-666666666666';
const out = [
  { type: 'system', subtype: 'init', session_id: sid, model: 'claude-haiku-5-5' },
  {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: prompt.includes('LEAK:') ? prompt.split('LEAK:')[1].trim() : 'ok' },
      ],
    },
    session_id: sid,
  },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: JSON.stringify(results),
    session_id: sid,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
];
for (const l of out) process.stdout.write(JSON.stringify(l) + '\n');
