import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from '../playwright.config';

const WORK = join(process.env.AF_E2E_WORK!, 'runtime');

test('run the project, preview it, catch an error, browse code and use a terminal', async ({
  page,
  request,
}) => {
  mkdirSync(WORK, { recursive: true });
  const created = await request.post(`${E2E.daemonUrl}/api/projects`, {
    data: {
      mode: 'scratch',
      name: 'Runner',
      location: { kind: 'local', parentDir: WORK, folderName: `runner-${Date.now() % 100000}` },
    },
  });
  expect(created.ok()).toBe(true);
  const project = (await created.json()) as { id: string; localPath: string };
  // Keep the pipeline out of this test: a "Fix with agent" task should just wait.
  await request.post(`${E2E.daemonUrl}/api/projects/${project.id}/pipeline/pause`);

  const port = 4500 + (Date.now() % 400);
  writeFileSync(
    join(project.localPath, 'server.js'),
    `require('node:http').createServer((_, res) => res.end('<h1>Hello from the runner app</h1>')).listen(${port}, () => console.log('Listening on http://localhost:${port}'));\n`,
  );
  writeFileSync(join(project.localPath, 'app.ts'), 'export const answer: number = 42;\n');
  await request.patch(`${E2E.daemonUrl}/api/projects/${project.id}`, {
    data: {
      commands: {
        run: 'node server.js',
        build: `printf "app.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.\\n"; exit 2`,
      },
    },
  });

  await page.goto(`/projects/${project.id}`);
  // Run → status, preview URL and the run terminal.
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-status')).toHaveText('Running', { timeout: 15_000 });
  await expect(page.getByRole('link', { name: `localhost:${port}` })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Terminals' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Dev server', exact: true })).toBeVisible();

  await page.getByRole('tab', { name: 'Preview' }).click();
  await expect(
    page
      .frameLocator('iframe[title="App preview"]')
      .getByRole('heading', { name: 'Hello from the runner app' }),
  ).toBeVisible({ timeout: 10_000 });

  // Build from the menu → the TypeScript error is detected and badged.
  await page.getByRole('button', { name: 'More run commands' }).click();
  await page.getByRole('menuitem', { name: /Build/ }).click();
  await expect(page.getByTestId('errors-count')).toHaveText('1', { timeout: 10_000 });
  await page.getByRole('tab', { name: /Errors/ }).click();
  const errors = page.getByTestId('errors-list');
  await expect(errors).toContainText("TS2322: Type 'string' is not assignable to type 'number'.");

  // Jump to the file in the Code tab (Monaco, read-only).
  await errors.getByRole('button', { name: 'app.ts:1' }).click();
  await expect(page.getByTestId('code-path')).toHaveText('app.ts');
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('export const answer', {
    timeout: 15_000,
  });

  // Fix with agent → a fix task exists and the error is being fixed.
  await errors.getByRole('button', { name: 'Fix with agent' }).click();
  await expect(errors.getByRole('button', { name: 'Fixing — view task' })).toBeVisible();
  await expect(page.getByTestId('errors-count')).toHaveCount(0);

  // A shell terminal in the project folder.
  await page.getByRole('tab', { name: 'Terminals' }).click();
  await page.getByRole('button', { name: 'New terminal' }).click();
  await expect(page.getByRole('button', { name: 'Terminal 1', exact: true })).toBeVisible();
  await page.locator('.xterm').last().click();
  await page.keyboard.type('echo marker-$((40+2))\n');
  await expect(page.locator('.xterm-rows').last()).toContainText('marker-42', { timeout: 10_000 });

  // Stop.
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByTestId('run-status')).toHaveText('Stopped', { timeout: 10_000 });
});
