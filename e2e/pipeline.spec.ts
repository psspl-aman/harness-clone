import { expect, test, type APIRequestContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from '../playwright.config';

const WORK = join(process.env.AF_E2E_WORK!, 'pipeline');

/** Claude Code stream-json transcript whose final answer is `text`. */
const stream = (text: string, tool = 'Bash') => {
  const sid = '99999999-0000-4000-8000-0000000000aa';
  return [
    { type: 'system', subtype: 'init', session_id: sid, model: 'claude-haiku-5-5' },
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: tool, input: { command: 'ls' } }] },
      session_id: sid,
    },
    {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }],
      },
      session_id: sid,
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: text,
      session_id: sid,
      total_cost_usd: 0.004,
      usage: {
        input_tokens: 5,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      modelUsage: {
        'claude-haiku-5-5': {
          inputTokens: 900,
          outputTokens: 120,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.004,
        },
      },
    },
  ].map((l) => JSON.stringify(l));
};

const task = (ref: string, title: string) => ({
  ref,
  title,
  description: `Create ${title.toLowerCase()}.`,
  type: 'feature',
  priority: 'medium',
  complexity: 'xs',
  acceptanceCriteria: [`${title} exists`],
  dependsOn: [],
});

/** One fake CLI for every role; picks a reply by the role header in the prompt and edits files like a real agent. */
function fakeAgent() {
  mkdirSync(WORK, { recursive: true });
  const path = join(WORK, 'claude');
  const roles = {
    planner: {
      text: JSON.stringify({
        type: 'plan',
        message: 'Two tiny tasks.',
        plan: { goal: 'Greeting files' },
        tasks: [task('T1', 'Hello file'), task('T2', 'Bye file')],
      }),
    },
    developer: { text: 'Implemented the file.', write: true },
    reviewer: {
      text: JSON.stringify({
        verdict: 'APPROVE',
        summary: 'Small and correct.',
        comments: [{ file: 'hello.txt', line: 1, severity: 'info', body: 'Nice and short' }],
      }),
    },
    tester: {
      text: JSON.stringify({
        passed: true,
        summary: 'File checks pass.',
        total: 1,
        failed: 0,
        commands: ['test -f'],
      }),
    },
    fixer: { text: 'Applied your change.', fix: true },
    documenter: {
      text: JSON.stringify({
        summary: 'Added the greeting file.',
        report: 'Created the greeting file at the repo root.',
        docsUpdated: [],
      }),
    },
  };
  writeFileSync(
    `${path}.roles.json`,
    JSON.stringify(
      Object.fromEntries(
        Object.entries(roles).map(([k, v]) => [k, { ...v, lines: stream(v.text) }]),
      ),
    ),
  );
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2).join(' ');
if (args.startsWith('--version')) { console.log('2.1.327 (Claude Code)'); process.exit(0); }
if (args.startsWith('auth status')) { console.log(JSON.stringify({ loggedIn: true, loginExpiresAt: '2099-01-01T00:00:00Z' })); process.exit(0); }
let stdin = ''; try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
const roles = JSON.parse(fs.readFileSync(${JSON.stringify(`${path}.roles.json`)}, 'utf8'));
const role = stdin.includes('You are the Planner agent') ? 'planner' : (stdin.match(/# Role: (\\w+)/) || [])[1]?.toLowerCase();
const r = roles[role];
if (!r) { console.error('fake: unknown role'); process.exit(2); }
const key = (stdin.match(/## Task ([A-Z]+-\\d+)/) || [])[1] || 'X';
if (r.write) fs.writeFileSync(key.toLowerCase() + '.txt', 'Hello from ' + key + '\\n');
if (r.fix) fs.writeFileSync(key.toLowerCase() + '.txt', 'Changed by the fixer\\n');
setTimeout(() => process.stdout.write(r.lines.slice(0, 3).join('\\n') + '\\n'), 200);
setTimeout(() => { process.stdout.write(r.lines[3] + '\\n'); process.exit(0); }, 900);
`,
  );
  chmodSync(path, 0o755);
  return path;
}

async function newProject(request: APIRequestContext, name: string) {
  const p = await request.post(`${E2E.daemonUrl}/api/projects`, {
    data: {
      mode: 'scratch',
      name,
      location: {
        kind: 'local',
        parentDir: WORK,
        folderName: `${name.toLowerCase().replace(/\W+/g, '-')}-${Date.now() % 100000}`,
      },
    },
  });
  expect(p.ok()).toBe(true);
  const project = await p.json();
  await request.patch(`${E2E.daemonUrl}/api/projects/${project.id}`, {
    data: { commands: { test: 'ls *.txt' } },
  });
  return project as { id: string; localPath: string };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  await request.patch(`${E2E.daemonUrl}/api/engines/claude-code`, {
    data: { binaryPath: fakeAgent(), enabled: true },
  });
  await request.post(`${E2E.daemonUrl}/api/engines/claude-code/refresh`);
  await request.patch(`${E2E.daemonUrl}/api/settings`, {
    data: {
      defaultEngines: {
        planner: 'claude-code',
        developer: 'claude-code',
        reviewer: 'claude-code',
        tester: 'claude-code',
        fixer: 'claude-code',
        documenter: 'claude-code',
      },
      pipeline: { requireHumanReviewBeforeMerge: false, maxFixLoops: 3 },
      concurrency: { maxTasksPerProject: 2 },
    },
  });
});

test('approve a plan and watch agents build and merge it', async ({ page, request }) => {
  const project = await newProject(request, 'Greetings');
  await page.goto(`/projects/${project.id}`);
  await page.getByLabel('Message the Planner').fill('Two greeting files');
  await page.getByRole('button', { name: 'Send (⌘↵)' }).click();
  await expect(page.getByText('Plan v1')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: /Approve all \(2\)/ }).click();
  const bar = page.getByLabel('Build pipeline');
  await expect(bar.getByText('Building', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(bar.getByLabel('Live agent activity')).toContainText(
    /Developing|Reviewing|Testing|Documenting/,
  );
  // The bottom panel streams each running agent's output.
  await page.getByRole('tab', { name: 'Agents' }).click();
  await expect(page.getByTestId('agents-pane')).toContainText(/GRE-\d/, { timeout: 10_000 });
  const list = page.getByRole('list', { name: 'Tasks' });
  await expect(list.getByLabel(/^Engines: Developer Claude Code/).first()).toBeVisible();
  await expect(list.getByText('Done')).toHaveCount(2, { timeout: 60_000 });
  await expect(page.getByText('GRE-1 done').first()).toBeVisible();
  await expect(list.getByRole('progressbar', { name: 'GRE-1 progress' })).toHaveAttribute(
    'aria-valuenow',
    '100',
  );

  // Merged into the user's repo.
  expect(readFileSync(join(project.localPath, 'gre-1.txt'), 'utf8')).toBe('Hello from GRE-1\n');
  expect(
    execFileSync('git', ['log', '--merges', '--format=%s'], {
      cwd: project.localPath,
      encoding: 'utf8',
    }),
  ).toContain('Merge GRE-1: Hello file');

  // Drawer: activity, changes, review & tests, report.
  await page.getByRole('button', { name: /Hello file/ }).click();
  const d = page.getByRole('dialog');
  await d.getByRole('tab', { name: 'Activity' }).click();
  // .first(): a role can run more than once (the Reviewer reviews the code, then the tests).
  for (const verb of ['Developing', 'Reviewing', 'Testing', 'Documenting'])
    await expect(d.getByRole('button', { name: new RegExp(verb) }).first()).toBeVisible();
  await d.getByRole('tab', { name: 'Changes' }).click();
  await expect(d.getByText('gre-1.txt')).toBeVisible();
  await expect(d.getByText('+Hello from GRE-1')).toBeVisible();
  await d.getByRole('tab', { name: 'Review & tests' }).click();
  await expect(d.getByText('Reviewer: approved')).toBeVisible();
  await expect(d.getByText('Nice and short')).toBeVisible();
  await d.getByRole('button', { name: 'Show log' }).click();
  await expect(d.getByText('$ ls *.txt')).toBeVisible();
  await d.getByRole('tab', { name: 'Report' }).click();
  await expect(d.getByRole('heading', { name: 'GRE-1: Hello file' })).toBeVisible();
  await expect(d.getByText('Created the greeting file at the repo root.')).toBeVisible();
  await page.keyboard.press('Escape');

  // Code → Changes shows each task's diff.
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  await page.getByRole('tab', { name: 'Changes' }).click();
  await page.getByRole('button', { name: /GRE-1/ }).click();
  await expect(page.getByTestId('code-changes')).toContainText('gre-1.txt');
});

test('review before merge: request changes, then approve the merge', async ({ page, request }) => {
  await request.patch(`${E2E.daemonUrl}/api/settings`, {
    data: { pipeline: { requireHumanReviewBeforeMerge: true } },
  });
  const project = await newProject(request, 'Reviewed');
  await page.goto(`/projects/${project.id}`);
  await page.getByLabel('Message the Planner').fill('Two greeting files');
  await page.getByRole('button', { name: 'Send (⌘↵)' }).click();
  await expect(page.getByText('Plan v1')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /Hello file/ }).click();
  const d = page.getByRole('dialog');
  await d.getByRole('button', { name: 'Approve' }).click();
  const merge = d.getByRole('button', { name: 'Approve & merge' });
  await expect(merge).toBeVisible({ timeout: 60_000 });
  expect(() => readFileSync(join(project.localPath, 'rev-1.txt'))).toThrow(); // not merged yet

  await d.getByLabel('Requested changes').fill('Make the greeting say it was changed');
  await d.getByRole('button', { name: 'Request changes' }).click();
  await expect(merge).toBeHidden(); // back in the pipeline: Fixer → Review → Test → Document
  await expect(merge).toBeVisible({ timeout: 60_000 });
  await d.getByRole('tab', { name: 'Review & tests' }).click();
  await expect(d.getByText('You: changes requested')).toBeVisible();
  await merge.click();
  await expect(d.getByText('Done', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  expect(readFileSync(join(project.localPath, 'rev-1.txt'), 'utf8')).toBe('Changed by the fixer\n');
  await request.patch(`${E2E.daemonUrl}/api/settings`, {
    data: { pipeline: { requireHumanReviewBeforeMerge: false } },
  });
});
