import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from '../playwright.config';

const WORK = process.env.AF_E2E_WORK!;
const uid = () => Math.random().toString(36).slice(2, 8);

test('create a project from scratch through the wizard', async ({ page }) => {
  const name = `Recipe Planner ${uid()}`;
  const parent = join(WORK, `parent-${uid()}`);
  mkdirSync(parent);

  await page.goto('/');
  await page.getByRole('link', { name: 'New project' }).first().click();
  await expect(page).toHaveURL(/mode=scratch/);

  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  // Location: use the folder picker to choose the parent.
  await page.getByRole('button', { name: 'Browse' }).click();
  const picker = page.getByRole('dialog');
  await picker.getByRole('button', { name: 'Home folder' }).click();
  await page.getByPlaceholder('/home/you/code').fill(parent); // picker re-opens at typed path
  await picker.getByRole('button', { name: 'Select this folder' }).click();
  await expect(picker).toBeHidden();
  await page.getByPlaceholder('/home/you/code').fill(parent);
  await expect(page.getByText('Folder will be created')).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  await page.getByRole('button', { name: 'Next.js' }).click();
  await page.getByRole('button', { name: 'SQLite' }).click();
  await expect(page.getByLabel('Stack preferences')).toHaveValue('Next.js, SQLite');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click(); // engines: keep defaults
  await page.getByLabel('What should we build?').fill('A meal planner with a shopping list.');
  // Requirement documents: upload two, remove one.
  await page.getByLabel('Attach requirement documents').setInputFiles([
    { name: 'brief.md', mimeType: 'text/markdown', buffer: Buffer.from('# Brief\nWeekly menus') },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Vegetarian first') },
  ]);
  const docs = page.getByRole('list', { name: 'Attached documents' });
  await expect(docs.getByRole('listitem')).toHaveCount(2);
  await docs.getByRole('button', { name: 'Remove notes.txt' }).click();
  await expect(docs.getByRole('listitem')).toHaveCount(1);
  // The same file again is skipped, not uploaded twice.
  await page
    .getByLabel('Attach requirement documents')
    .setInputFiles([
      { name: 'brief.md', mimeType: 'text/markdown', buffer: Buffer.from('# Brief\nWeekly menus') },
    ]);
  await expect(page.getByText('brief.md is already attached')).toBeVisible();
  await expect(docs.getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  await expect(page.getByText('brief.md')).toBeVisible();
  await expect(page.getByText('Planner decides')).toBeHidden();
  await expect(page.getByText('Next.js, SQLite')).toBeVisible();
  await page.getByRole('button', { name: 'Create project' }).click();

  await expect(page).toHaveURL(/\/projects\/prj_/);
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
  await expect(page.getByText('A meal planner with a shopping list.')).toBeVisible();
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(
    page.getByText('The folder is empty — agents will scaffold it from your requirements.'),
  ).toBeVisible();
  const folder = join(parent, name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-'));
  expect(existsSync(join(folder, '.git'))).toBe(true);
  // The document went into the project (git-excluded), attached to the first requirement.
  const attached = readdirSync(join(folder, '.agentforge/attachments'));
  expect(attached).toHaveLength(1);
  expect(existsSync(join(folder, '.agentforge/attachments', attached[0]!, 'brief.md'))).toBe(true);

  await page.getByRole('link', { name: 'Projects' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
});

test('attach an existing folder, confirm commands, archive, restore and delete it', async ({
  page,
  request,
}) => {
  const dir = join(WORK, `legacy-${uid()}`);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'legacy',
      scripts: { dev: 'vite', build: 'vite build' },
      devDependencies: { vite: '7' },
    }),
  );
  writeFileSync(join(dir, 'package-lock.json'), '{}');
  writeFileSync(join(dir, 'src/main.js'), 'console.log(1)');
  writeFileSync(join(dir, '.env'), 'TOKEN=never-commit-me'); // gforge:allow — fake fixture

  await page.goto('/projects/new');
  await page.getByRole('link', { name: /Attach existing project/ }).click();
  await page.getByPlaceholder('/home/you/code').fill(dir);
  await expect(
    page.getByText('Not a git repository — AgentForge will initialise one'),
  ).toBeVisible();
  await expect(page.getByText('Initialise a git repository')).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByLabel('Project name')).toHaveValue(/legacy-/);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('(git will be initialised)')).toBeVisible();
  await page.getByRole('button', { name: 'Attach project' }).click();

  await expect(page).toHaveURL(/\/projects\/prj_/);
  await page.getByRole('tab', { name: 'Overview' }).click();
  const run = page.getByLabel('Run (dev server)');
  await expect(run).toHaveValue('npm run dev');
  await expect(page.getByText('Detected from package.json scripts.dev')).toBeVisible();
  await expect(page.getByText('.env', { exact: true })).toBeVisible();
  const tracked = execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' });
  expect(tracked).toContain('package.json');
  expect(tracked).not.toContain('.env\n');

  await run.fill('npm run dev -- --port 5999');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Commands saved')).toBeVisible();
  await page.reload();
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(page.getByLabel('Run (dev server)')).toHaveValue('npm run dev -- --port 5999');
  await expect(page.getByRole('button', { name: /use npm run dev/ })).toBeVisible();

  const id = page.url().split('/').pop()!;
  const projectName = (await (await request.get(`${E2E.daemonUrl}/api/projects/${id}`)).json())
    .name as string;
  // Archive: off the dashboard, but kept and restorable.
  await page.getByRole('button', { name: 'Archive' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Archive project' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: projectName })).toBeHidden();
  const archived = page.getByRole('region', { name: 'Archived projects' });
  await archived.getByRole('button', { name: /Archived projects/ }).click();
  const row = archived.getByRole('listitem').filter({ hasText: projectName });
  await row.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByRole('heading', { name: projectName })).toBeVisible();

  // Archive again, then delete for good from the archived list.
  await page.goto(`/projects/${id}`);
  await page.getByRole('button', { name: 'Archive' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Archive project' }).click();
  await expect(page).toHaveURL(/\/$/);
  await archived.getByRole('button', { name: /Archived projects/ }).click();
  await row.getByRole('button', { name: `Delete ${projectName} permanently` }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Delete permanently' })).toBeDisabled();
  await dialog.getByLabel('Confirm project name').fill(projectName);
  await dialog.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(archived).toBeHidden();
  expect((await request.get(`${E2E.daemonUrl}/api/projects/${id}`)).status()).toBe(404);
  expect(existsSync(join(dir, 'src/main.js'))).toBe(true);
});

test('wizard blocks invalid locations', async ({ page }) => {
  const dir = join(WORK, `busy-${uid()}`);
  mkdirSync(join(dir, 'taken'), { recursive: true });
  writeFileSync(join(dir, 'taken/file.txt'), 'x');
  await page.goto('/projects/new?mode=scratch');
  await page.getByLabel('Project name').fill('taken');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByPlaceholder('/home/you/code').fill(dir);
  await expect(page.getByText(/Folder is not empty/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
});

test('integrations page offers GitHub token connection', async ({ page }) => {
  await page.goto('/integrations');
  await expect(page.getByRole('heading', { name: 'Integrations' })).toBeVisible();
  await expect(page.getByLabel('Personal access token')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled();
});
