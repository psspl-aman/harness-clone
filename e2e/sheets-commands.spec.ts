import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from '../playwright.config';

const WORK = join(process.env.AF_E2E_WORK!, 'sheets');
/** Set AF_E2E_SHOTS to a folder to save screenshots of the new screens. */
const shot = async (page: Page, name: string) => {
  if (process.env.AF_E2E_SHOTS)
    await page.screenshot({ path: join(process.env.AF_E2E_SHOTS, `${name}.png`), fullPage: true });
};

async function newProject(request: APIRequestContext, name: string) {
  mkdirSync(WORK, { recursive: true });
  const created = await request.post(`${E2E.daemonUrl}/api/projects`, {
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
  expect(created.ok()).toBe(true);
  const project = (await created.json()) as { id: string; localPath: string };
  // Keep agents out of these tests: approved tasks just wait.
  await request.post(`${E2E.daemonUrl}/api/projects/${project.id}/pipeline/pause`);
  return project;
}

test('connect a spreadsheet and its rows become tasks in priority order', async ({
  page,
  request,
}) => {
  const project = await newProject(request, 'Sheet Shop');
  const csv = join(WORK, `backlog-${Date.now() % 100000}.csv`);
  writeFileSync(
    csv,
    [
      'ID,Title,Description,Priority,Status',
      'S-1,Polish footer,Spacing tweaks,Low,',
      'S-2,Fix checkout crash,Throws on an empty cart,P0,',
      'S-3,Old idea,,High,Done',
      'S-4,Add product search,Search by name,High,',
    ].join('\n'),
  );

  await page.goto('/integrations');
  const card = page.locator('[data-slot="card"]', { hasText: 'Spreadsheets' });
  await card.getByRole('button', { name: 'Connect sheet' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Project' }).click();
  await page.getByRole('option', { name: 'Sheet Shop' }).click();
  await dialog.getByRole('radio', { name: /Excel or CSV file/ }).click();
  await dialog.getByLabel('File path').fill(csv);
  await dialog.getByRole('button', { name: 'Preview' }).click();
  const rows = dialog.locator('tbody tr');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('Fix checkout crash');
  await expect(rows.nth(1)).toContainText('Add product search');
  await expect(dialog).toContainText('3 tasks to import');
  await dialog.getByRole('switch', { name: /Let the Planner detail/ }).click();
  await shot(page, 'sheet-dialog');
  await dialog.getByRole('button', { name: 'Connect & import' }).click();
  await expect(dialog).toBeHidden();

  const row = card.getByRole('listitem').filter({ hasText: 'Sheet Shop' });
  await expect(row).toContainText(/3 new · 3 started/, { timeout: 10_000 });
  await shot(page, 'integrations');

  await page.goto(`/projects/${project.id}`);
  await page.getByRole('tab', { name: 'Plan & Tasks' }).click();
  await expect(page.getByText('Fix checkout crash').first()).toBeVisible();
  await expect(page.getByText('Polish footer').first()).toBeVisible();
  await expect(page.getByText('Old idea')).toHaveCount(0);
});

test('requirements chat: attach a spreadsheet and import its rows as tasks, one at a time', async ({
  page,
  request,
}) => {
  const project = await newProject(request, 'Chat Sheet');
  const csv = join(WORK, `chat-backlog-${Date.now() % 100000}.csv`);
  writeFileSync(
    csv,
    [
      'Title,Priority,Status',
      'Write docs,Low,',
      'Fix login bug,P0,',
      'Shipped thing,High,Done',
    ].join('\n'),
  );

  await page.goto(`/projects/${project.id}`);
  const composer = page.getByLabel('Message the Planner');
  // A pasted Google Sheets link is offered as an import.
  await composer.fill('tasks: https://docs.google.com/spreadsheets/d/abc123/edit#gid=0');
  await expect(page.getByText('Google Sheet link — turn its rows into tasks?')).toBeVisible();
  await composer.fill('');

  // An attached .csv can be imported straight from the chat.
  await page.locator('input[type=file][aria-label="Attach files"]').setInputFiles(csv);
  await page.getByRole('button', { name: 'Import as tasks' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('2 tasks to import');
  await dialog.getByRole('switch', { name: /Let the Planner detail/ }).click();
  await expect(dialog.getByRole('switch', { name: /one at a time/ })).toBeChecked();
  await dialog.getByRole('button', { name: 'Connect & import' }).click();
  await expect(dialog).toBeHidden();

  // The chat shows the sheet and its progress; the attachment chip is gone.
  await expect(page.getByText('Task sheets')).toBeVisible();
  await expect(page.getByText(/0\/2 done/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Import as tasks' })).toHaveCount(0);

  const detail = await (await request.get(`${E2E.daemonUrl}/api/projects/${project.id}`)).json();
  expect(JSON.stringify(detail)).toContain('"maxConcurrentTasks":1');
});

test('overview: several servers run together, and the cost card', async ({ page, request }) => {
  const project = await newProject(request, 'Two Servers');
  const base = 4600 + (Date.now() % 300);
  const [webPort, apiPort] = [base, base + 1];
  mkdirSync(join(project.localPath, 'api'), { recursive: true });
  const server = (label: string) =>
    `require('node:http').createServer((_, res) => res.end('<h1>${label}</h1>')).listen(process.env.PORT, () => console.log('${label} on http://localhost:' + process.env.PORT));\n`;
  writeFileSync(join(project.localPath, 'web.js'), server('Web app'));
  writeFileSync(join(project.localPath, 'api', 'api.js'), server('API'));
  const saved = await request.patch(`${E2E.daemonUrl}/api/projects/${project.id}`, {
    data: {
      commands: {
        services: [
          { name: 'web', command: 'node web.js', port: webPort },
          { name: 'api', command: 'node api.js', cwd: 'api', port: apiPort },
        ],
      },
    },
  });
  expect(saved.ok()).toBe(true);

  await page.goto(`/projects/${project.id}`);
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(page.getByText('Several servers?')).toBeVisible();
  await expect(page.getByLabel('Command', { exact: true }).nth(1)).toHaveValue('node api.js');
  await expect(page.getByRole('button', { name: 'Suggest with AI' })).toBeVisible();
  await expect(page.getByText('No agent runs yet')).toBeVisible();
  await shot(page, 'overview');

  // Role dropdowns only offer engines that are installed (Codex isn't, in this environment).
  await page.getByRole('combobox', { name: 'Developer' }).click();
  await expect(page.getByRole('option', { name: /Claude Code/ }).first()).toBeVisible();
  await expect(page.getByRole('option', { name: /OpenAI Codex/ })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('run-services')).toHaveText('2/2 servers', { timeout: 15_000 });
  await page.getByTestId('run-services').click();
  await expect(page.getByRole('menuitem', { name: /api/ })).toContainText(
    `http://localhost:${apiPort}`,
  );
  await shot(page, 'servers-menu');
  await page.keyboard.press('Escape');

  await page.getByRole('tab', { name: 'Preview' }).click();
  await expect(
    page.frameLocator('iframe[title="App preview"]').getByRole('heading', { name: 'Web app' }),
  ).toBeVisible({ timeout: 10_000 });
  await page.getByRole('tab', { name: 'api', exact: true }).click();
  await expect(
    page.frameLocator('iframe[title="App preview"]').getByRole('heading', { name: 'API' }),
  ).toBeVisible({ timeout: 10_000 });
  await shot(page, 'preview-api');

  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByTestId('run-status')).toHaveText('Stopped', { timeout: 10_000 });
});
