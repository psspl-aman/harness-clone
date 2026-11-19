import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from '../playwright.config';

const WORK = join(process.env.AF_E2E_WORK!, 'integrations');
const SERVER = join(process.cwd(), 'apps/daemon/test/fixtures/fake-pms-mcp.mjs');
const TOKEN = 'e2e-token'; // gforge:allow — fake token for the fake tracker

test('connect a tracker over MCP, import tickets, handle a change and write back', async ({
  page,
  request,
}) => {
  mkdirSync(WORK, { recursive: true });
  const statePath = join(WORK, `tracker-${Date.now()}.json`);
  writeFileSync(
    statePath,
    JSON.stringify({
      issues: [
        {
          project: 'WEB',
          key: 'WEB-1',
          title: 'Add a contact form',
          description: 'Name, email, message.',
          status: { name: 'To Do' },
          labels: [],
          url: 'https://tracker.example/WEB-1',
        },
        {
          project: 'WEB',
          key: 'WEB-2',
          title: 'Fix the footer link',
          description: 'It points to /old.',
          status: { name: 'To Do' },
          labels: ['bug'],
        },
        {
          project: 'WEB',
          key: 'WEB-3',
          title: 'Old work',
          description: '',
          status: { name: 'Done' },
          labels: [],
        },
      ],
      comments: [],
      transitions: [],
    }),
  );
  const tracker = () => JSON.parse(readFileSync(statePath, 'utf8'));

  // 1. MCP server with a secret env var.
  await page.goto('/integrations');
  await page.getByRole('button', { name: 'Add server' }).click();
  const sd = page.getByRole('dialog');
  await sd.getByLabel('Name', { exact: true }).fill('Fake tracker');
  await sd.getByLabel('Command').fill(process.execPath);
  await sd.getByLabel('Arguments (one per line)').fill(SERVER);
  for (const [i, [k, v]] of [
    ['FAKE_PMS_STATE', statePath],
    ['FAKE_PMS_REQUIRE_TOKEN', TOKEN],
    ['FAKE_PMS_TOKEN', TOKEN],
  ].entries()) {
    await sd.getByRole('button', { name: 'Add variable' }).click();
    await sd.getByLabel(`Name ${i + 1}`).fill(k!);
    await sd.getByLabel(`Value ${i + 1}`).fill(v!);
  }
  await sd.getByRole('button', { name: 'Mark FAKE_PMS_TOKEN as secret' }).click();
  await sd.getByRole('button', { name: 'Save and test' }).click();
  const row = page.getByTestId('mcp-Fake tracker');
  await expect(row.getByText('Connected · 4 tools')).toBeVisible({ timeout: 15_000 });
  await row.getByRole('button', { name: /Show tools/ }).click();
  await expect(row.getByText('search_issues')).toBeVisible();

  // 2. Tracker connection: auto-detect the tools, preview the tickets.
  await page.getByRole('button', { name: 'Connect tracker' }).click();
  const cd = page.getByRole('dialog');
  await cd.getByLabel('Tracker', { exact: true }).click();
  await page.getByRole('option', { name: 'Other (custom MCP server)' }).click();
  await cd.getByLabel('Name').fill('Fake Jira');
  await cd.getByLabel('MCP server').click();
  await page.getByRole('option', { name: 'Fake tracker' }).click();
  await cd.getByRole('button', { name: 'Auto-detect' }).click();
  await expect(page.getByText('Found 4 of 4 operations')).toBeVisible();
  await cd.getByLabel('Try it').fill('WEB');
  await cd.getByRole('button', { name: 'Preview' }).click();
  await expect(cd.getByTestId('pms-preview')).toContainText('WEB-1');
  await expect(cd.getByText('3 issues found')).toBeVisible();
  await cd.getByRole('button', { name: 'Save connection' }).click();
  await expect(page.getByTestId('pms-Fake Jira')).toContainText('via Fake tracker');

  // 3. Link a project and sync.
  const created = await request.post(`${E2E.daemonUrl}/api/projects`, {
    data: {
      mode: 'scratch',
      name: 'Shop Site',
      location: { kind: 'local', parentDir: WORK, folderName: `shop-${Date.now() % 100000}` },
    },
  });
  const project = (await created.json()) as { id: string };
  await request.post(`${E2E.daemonUrl}/api/projects/${project.id}/pipeline/pause`);
  await page.goto(`/projects/${project.id}`);
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  const md = page.getByRole('dialog');
  await md.getByLabel('Project').fill('WEB');
  await md.getByRole('button', { name: /Use .* defaults/ }).click();
  await md.getByLabel('Enrich with Planner').click();
  await md.getByRole('button', { name: 'Link', exact: true }).click();
  const link = page.getByTestId('tracker-link');
  await expect(link).toContainText('Fake Jira');
  await link.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByText('2 new')).toBeVisible();
  await expect(link.getByTestId('sync-summary')).toContainText('3 tickets, 2 new');

  // 4. Imported drafts with their ticket ids; approving writes back.
  await page.getByRole('tab', { name: 'Plan & Tasks' }).click();
  await expect(page.getByText('WEB-2')).toBeVisible();
  await page
    .getByRole('button', { name: /Add a contact form/ })
    .first()
    .click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByTestId('ticket-link')).toContainText('Imported from WEB-1');
  await expect(drawer.getByTestId('ticket-link').getByRole('link')).toHaveAttribute(
    'href',
    'https://tracker.example/WEB-1',
  );
  await drawer.getByRole('button', { name: 'Approve' }).click();
  await expect.poll(() => tracker().transitions).toEqual([{ key: 'WEB-1', status: 'To Do' }]);

  // 5. The ticket changes after approval → flagged on the task; apply it.
  const s = tracker();
  s.issues[0].description = 'Name, email, message and a phone number.';
  writeFileSync(statePath, JSON.stringify(s));
  const mapping = (
    await (await request.get(`${E2E.daemonUrl}/api/projects/${project.id}/pms`)).json()
  )[0];
  await request.post(`${E2E.daemonUrl}/api/pms/mappings/${mapping.id}/sync`);
  const banner = drawer.getByTestId('pms-conflict');
  await expect(banner).toContainText('WEB-1 was edited in the tracker');
  await expect(banner).toContainText('a phone number');
  await banner.getByRole('button', { name: 'Apply update' }).click();
  await expect(banner).toHaveCount(0);
  await expect(drawer.locator('#task-desc')).toHaveValue(/a phone number/);
});
