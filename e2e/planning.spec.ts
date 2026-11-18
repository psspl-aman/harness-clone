import { expect, test, type APIRequestContext } from '@playwright/test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from '../playwright.config';

const WORK = join(process.env.AF_E2E_WORK!, 'planning');
let projectId = '';

/** Claude Code stream-json transcript whose final answer is `text`. */
function stream(text: string): string {
  const sid = '99999999-0000-4000-8000-000000000001';
  return [
    { type: 'system', subtype: 'init', session_id: sid, model: 'claude-haiku-5-5' },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'README.md' } }],
      },
      session_id: sid,
    },
    {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't1', content: '# demo', is_error: false }],
      },
      session_id: sid,
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: text,
      session_id: sid,
      total_cost_usd: 0.01,
      usage: {
        input_tokens: 5,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      modelUsage: {},
    },
  ]
    .map((l) => JSON.stringify(l))
    .join('\n');
}

/** Fake planner CLI: answers `-p` calls from a scripted sequence (each used once), with a small delay. */
function fakePlanner(answers: string[]) {
  mkdirSync(WORK, { recursive: true });
  const path = join(WORK, 'claude');
  writeFileSync(`${path}.answers.json`, JSON.stringify(answers.map(stream)));
  writeFileSync(`${path}.n`, '0');
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2).join(' ');
if (args.startsWith('--version')) { console.log('2.1.327 (Claude Code)'); process.exit(0); }
if (args.startsWith('auth status')) { console.log(JSON.stringify({ loggedIn: true, loginExpiresAt: '2099-01-01T00:00:00Z' })); process.exit(0); }
try { fs.readFileSync(0); } catch {}
const answers = JSON.parse(fs.readFileSync(${JSON.stringify(`${path}.answers.json`)}, 'utf8'));
const n = Number(fs.readFileSync(${JSON.stringify(`${path}.n`)}, 'utf8'));
fs.writeFileSync(${JSON.stringify(`${path}.n`)}, String(n + 1));
// Stream like a real agent: tool steps first, then the final result a little later.
const lines = (answers[n] || answers[answers.length - 1]).split('\\n');
setTimeout(() => process.stdout.write(lines.slice(0, -1).join('\\n') + '\\n'), 300);
setTimeout(() => { process.stdout.write(lines[lines.length - 1] + '\\n'); process.exit(0); }, 2000);
`,
  );
  chmodSync(path, 0o755);
  return path;
}

const task = (ref: string, title: string, dependsOn: string[] = []) => ({
  ref,
  title,
  description: `Implement ${title.toLowerCase()}.`,
  type: 'feature',
  priority: 'medium',
  complexity: 's',
  acceptanceCriteria: [`${title} works`],
  affectedAreas: ['src/index.ts'],
  dependsOn,
  subtasks: ['Write code', 'Write tests'],
});

async function setup(request: APIRequestContext) {
  const claude = fakePlanner([
    JSON.stringify({
      type: 'questions',
      message: 'One question first:',
      questions: [{ question: 'Where should it run?', options: ['Web', 'Terminal'] }],
    }),
    JSON.stringify({
      type: 'plan',
      message: 'A terminal notes app in three steps.',
      plan: {
        goal: 'Terminal notes app',
        scope: 'Add, list, delete notes',
        risks: ['File corruption'],
        assumptions: ['Single user'],
      },
      tasks: [
        task('T1', 'Scaffold the project'),
        task('T2', 'Store notes in a JSON file', ['T1']),
        task('T3', 'Add the CLI commands', ['T2']),
      ],
    }),
    JSON.stringify({ type: 'reply', message: 'A JSON file is simplest for a single user.' }),
  ]);
  const res = await request.patch(`${E2E.daemonUrl}/api/engines/claude-code`, {
    data: { binaryPath: claude, enabled: true },
  });
  expect(res.ok()).toBe(true);
  await request.post(`${E2E.daemonUrl}/api/engines/claude-code/refresh`);
  await request.patch(`${E2E.daemonUrl}/api/settings`, {
    data: { defaultEngines: { planner: 'claude-code' } },
  });
  const folder = `notes-${Math.random().toString(36).slice(2, 7)}`;
  const p = await request.post(`${E2E.daemonUrl}/api/projects`, {
    data: {
      mode: 'scratch',
      name: 'Notes CLI',
      location: { kind: 'local', parentDir: WORK, folderName: folder },
    },
  });
  expect(p.ok()).toBe(true);
  const project = await p.json();
  writeFileSync(join(project.localPath, 'README.md'), '# Notes');
  return project.id as string;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  projectId = await setup(request);
});

test('chat → clarifying question → plan', async ({ page }) => {
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByText('No plan yet')).toBeVisible();
  const input = page.getByLabel('Message the Planner');
  await input.fill('A notes app I can use quickly');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByRole('status', { name: 'Planner is working' })).toBeVisible();
  await expect(page.getByText('Read · README.md')).toBeVisible();
  await expect(page.getByText('Where should it run?')).toBeVisible();

  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(input).toHaveValue(/Where should it run\?\n→ Terminal/);
  await page.getByLabel("Don't ask questions").click();
  await page.getByRole('button', { name: 'Send (⌘↵)' }).click();
  await expect(page.getByRole('button', { name: 'Review plan' })).toBeVisible();
  await expect(page.getByText('Plan v1')).toBeVisible();
  await expect(page.getByText('Draft — needs your review')).toBeVisible();
  const list = page.getByRole('list', { name: 'Tasks' });
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await expect(list).toContainText('Store notes in a JSON file');
  await expect(list).toContainText('after NC-1');
});

test('review and edit tasks before approving', async ({ page }) => {
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('button', { name: /Add the CLI commands/ }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText('NC-3', { exact: true }).first()).toBeVisible();

  await drawer.getByLabel('Priority').click();
  await page.getByRole('option', { name: 'critical' }).click();
  await drawer.getByLabel('New Criterion').fill('`notes list` prints notes newest first');
  await drawer.getByRole('button', { name: 'Add Criterion' }).click();
  await expect(drawer.getByLabel('Criterion 2')).toHaveValue(
    '`notes list` prints notes newest first',
  );

  await drawer.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('checkbox', { name: /NC-1/ }).click();
  await page.keyboard.press('Escape');
  await expect(drawer.getByText('Scaffold the project')).toBeVisible();

  await drawer.getByLabel('New subtask').fill('Handle empty notes file');
  await page.keyboard.press('Enter');
  await expect(drawer.getByText('Handle empty notes file')).toBeVisible();
  await expect(drawer.getByText('Draft', { exact: true }).first()).toBeVisible();
  await page.keyboard.press('Escape');

  const list = page.getByRole('list', { name: 'Tasks' });
  await expect(list.getByRole('listitem').nth(2)).toContainText('critical');
  await expect(list.getByRole('listitem').nth(2)).toContainText(/after NC-[12], NC-[12]/);
  await expect(list.getByRole('listitem').nth(2)).toContainText('0/3 subtasks');

  await page.getByRole('button', { name: 'Approve NC-1' }).click();
  await expect(list.getByRole('listitem').first()).toContainText('Approved');
  await page.getByRole('button', { name: /Approve all \(2\)/ }).click();
  await expect(page.getByText(/Approved 2 tasks/)).toBeVisible();
  await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('3/3 approved')).toBeVisible();
});

test('board and dependency graph views', async ({ page }) => {
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: 'Board' }).click();
  await expect(page.getByRole('region', { name: 'Approved' })).toContainText('3');
  await expect(page.getByRole('region', { name: 'Approved' })).toContainText(
    'Store notes in a JSON file',
  );
  await page.getByRole('tab', { name: 'Graph' }).click();
  const graph = page.getByRole('img', { name: 'Task dependency graph' });
  await expect(graph.getByRole('button', { name: /NC-3 Add the CLI commands/ })).toBeVisible();
  await graph.getByRole('button', { name: /NC-2/ }).click();
  await expect(page.getByRole('dialog').getByText('NC-2', { exact: true }).first()).toBeVisible();
});

test('discuss without creating tasks, and @file autocomplete', async ({ page }) => {
  await page.goto(`/projects/${projectId}`);
  const input = page.getByLabel('Message the Planner');
  await input.fill('Should I use a JSON file? See @READ');
  await expect(page.getByRole('option', { name: /README\.md/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('Should I use a JSON file? See @README.md ');
  await page.getByRole('radio', { name: 'Discuss' }).click();
  await page.getByRole('button', { name: 'Send (⌘↵)' }).click();
  await expect(page.getByText('A JSON file is simplest for a single user.')).toBeVisible();
  await expect(page.getByText('README.md').first()).toBeVisible();
  await expect(page.getByRole('list', { name: 'Tasks' }).getByRole('listitem')).toHaveCount(3);
});
