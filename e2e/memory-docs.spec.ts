import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from '../playwright.config';

const WORK = join(process.env.AF_E2E_WORK!, 'memory');

test('project memory, global preferences and the Docs tab', async ({ page, request }) => {
  mkdirSync(WORK, { recursive: true });
  const created = await request.post(`${E2E.daemonUrl}/api/projects`, {
    data: {
      mode: 'scratch',
      name: 'Notes App',
      location: { kind: 'local', parentDir: WORK, folderName: `notes-${Date.now() % 100000}` },
    },
  });
  const project = (await created.json()) as { id: string; localPath: string };
  await request.post(`${E2E.daemonUrl}/api/projects/${project.id}/pipeline/pause`);
  writeFileSync(join(project.localPath, 'README.md'), '# Notes App\n\nTake notes **fast**.\n');
  mkdirSync(join(project.localPath, 'docs'), { recursive: true });
  writeFileSync(
    join(project.localPath, 'docs', 'guide.md'),
    '# User guide\n\n## Shortcuts\n\nPress N for a new note.\n',
  );

  // Memory: add, search, pin, edit, delete.
  await page.goto(`/projects/${project.id}`);
  await page.getByRole('tab', { name: 'Memory' }).click();
  await page.getByRole('button', { name: 'Add memory' }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Title').fill('Storage is SQLite');
  await dialog.getByLabel('Content').fill('Notes live in `notes.db`; use the repository layer.');
  await dialog.getByLabel('Tags').fill('storage');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Add memory' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Kind').click();
  await page.getByRole('option', { name: 'Pitfall' }).click();
  await dialog.getByLabel('Title').fill('Flaky sync test');
  await dialog.getByLabel('Content').fill('Mock the clock in sync tests.');
  await dialog.getByRole('button', { name: 'Save' }).click();

  const entries = page.getByTestId('memory-entry');
  await expect(entries.filter({ hasText: 'Storage is SQLite' })).toBeVisible();
  await page.getByLabel('Search memory').fill('clock');
  await expect(entries).toHaveCount(1);
  await expect(entries.first()).toContainText('Flaky sync test');
  await page.getByLabel('Search memory').fill('');

  await page.getByRole('button', { name: 'Pin Storage is SQLite' }).click();
  await expect(page.getByRole('button', { name: 'Unpin Storage is SQLite' })).toBeVisible();
  await expect(entries.first()).toContainText('Storage is SQLite'); // pinned first

  await page.getByRole('button', { name: 'Edit Flaky sync test' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Content').fill('Use fake timers in sync tests.');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(entries.filter({ hasText: 'Use fake timers' })).toBeVisible();

  // The readable mirror in the project folder.
  const mirror = join(project.localPath, '.ai-harness', 'memory.md');
  await expect
    .poll(() => existsSync(mirror) && readFileSync(mirror, 'utf8'))
    .toContain('### 📌 Storage is SQLite');

  await page.getByRole('button', { name: 'Delete Flaky sync test' }).click();
  await page.getByRole('button', { name: 'Delete?' }).click();
  await expect(entries.filter({ hasText: 'Flaky sync test' })).toHaveCount(0);
  await expect(entries.filter({ hasText: 'Storage is SQLite' })).toHaveCount(1);

  // Docs: README first, other Markdown files, download and print views.
  await page.getByRole('tab', { name: 'Docs' }).click();
  await expect(page.getByTestId('doc-title')).toHaveText('README.md');
  await expect(page.getByTestId('doc-content')).toContainText('Take notes fast.');
  await page.getByRole('button', { name: /docs\/guide\.md/ }).click();
  await expect(
    page.getByTestId('doc-content').getByRole('heading', { name: 'Shortcuts' }),
  ).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Markdown' }).click();
  expect((await download).suggestedFilename()).toBe('guide.md');
  await expect(page.getByRole('link', { name: 'Export all (.md)' })).toHaveAttribute(
    'href',
    `${E2E.daemonUrl}/api/projects/${project.id}/docs/export`,
  );

  const print = await page.context().newPage();
  await print.goto(
    `/projects/${project.id}/docs/print?doc=${encodeURIComponent('file:README.md')}`,
  );
  await expect(print.locator('.print-root')).toContainText('Take notes fast.');
  await print.close();

  // Global preferences live in Settings.
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Add preference' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Title').fill('Prefer small functions');
  await dialog.getByLabel('Content').fill('Keep functions under ~40 lines.');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(
    page.getByTestId('memory-entry').filter({ hasText: 'Prefer small functions' }),
  ).toBeVisible();
  const global = await (await request.get(`${E2E.daemonUrl}/api/memory`)).json();
  expect(global.map((m: { title: string; kind: string }) => [m.title, m.kind])).toContainEqual([
    'Prefer small functions',
    'preference',
  ]);
});
