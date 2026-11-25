import { expect, test, type APIRequestContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from '../playwright.config';

const WORK = join(process.env.AF_E2E_WORK!, 'git');

async function newProject(request: APIRequestContext, name: string) {
  mkdirSync(WORK, { recursive: true });
  const created = await request.post(`${E2E.daemonUrl}/api/projects`, {
    data: {
      mode: 'scratch',
      name,
      location: { kind: 'local', parentDir: WORK, folderName: `git-${Date.now() % 100000}` },
    },
  });
  expect(created.ok()).toBe(true);
  const project = (await created.json()) as { id: string; localPath: string };
  await request.post(`${E2E.daemonUrl}/api/projects/${project.id}/pipeline/pause`);
  return project;
}

test('git tab: commit, branch, merge and delete without leaving the app', async ({
  page,
  request,
}) => {
  const project = await newProject(request, 'Git Flow');
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: project.localPath, encoding: 'utf8' }).trim();
  writeFileSync(join(project.localPath, 'hello.txt'), 'hello\n');

  await page.goto(`/projects/${project.id}`);
  await page.getByRole('tab', { name: 'Git', exact: true }).click();
  await expect(page.getByTestId('git-current')).toHaveText('main');
  await expect(page.getByLabel('Working branch')).toHaveText('main');

  // Commit what's in the folder.
  await page.getByRole('button', { name: '1 uncommitted change' }).click();
  await expect(page.getByLabel('Uncommitted changes')).toContainText('hello.txt');
  await page.getByLabel('Commit message').fill('Add hello');
  await page.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(page.getByText('Committed 1 file to main')).toBeVisible();
  await expect(page.getByText('Nothing uncommitted on main.')).toBeVisible();

  // A branch of our own, switched to.
  await page.getByRole('button', { name: 'New branch' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Branch name').fill('feature/greeting');
  await dialog.getByRole('button', { name: 'Create branch' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('git-current')).toHaveText('feature/greeting');
  writeFileSync(join(project.localPath, 'greeting.txt'), 'hi there\n');
  await page.getByRole('button', { name: '1 uncommitted change' }).click();
  await page.getByLabel('Commit message').fill('Add greeting');
  await page.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(page.getByText('Committed 1 file to feature/greeting')).toBeVisible();

  // It's one commit ahead of main; merge it from its menu.
  await page.getByRole('tab', { name: /^Branches/ }).click();
  const row = page.locator('[data-testid="git-branch-row"][data-branch="feature/greeting"]');
  await expect(row).toContainText('1');
  await expect(row).toContainText('vs main');
  await row.getByRole('button', { name: 'Actions for feature/greeting' }).click();
  await page.getByRole('menuitem', { name: /Merge into main/ }).click();
  await expect(page.getByText('Merged feature/greeting into main')).toBeVisible();
  await expect(row).toContainText('merged');
  expect(git('log', 'main', '-1', '--format=%s')).toBe('Merge feature/greeting into main');

  // Branch detail shows what's on it.
  await row
    .getByRole('button', { name: /feature\/greeting/ })
    .first()
    .click();
  await expect(page.getByText('Add greeting').first()).toBeVisible();

  // Back to main, then delete the merged branch.
  const main = page.locator('[data-testid="git-branch-row"][data-branch="main"]');
  await main.getByRole('button', { name: 'Actions for main' }).click();
  await page.getByRole('menuitem', { name: 'Switch to this branch' }).click();
  await expect(page.getByTestId('git-current')).toHaveText('main');
  await row.getByRole('button', { name: 'Actions for feature/greeting' }).click();
  await page.getByRole('menuitem', { name: 'Delete branch' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete branch' }).click();
  await expect(page.getByText('Deleted feature/greeting')).toBeVisible();
  await expect(row).toHaveCount(0);

  await page.getByRole('tab', { name: /Work by branch/ }).click();
  await expect(page.getByText('No agent work yet.', { exact: false })).toBeVisible();
});
