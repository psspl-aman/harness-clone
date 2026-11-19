import { expect, test } from '@playwright/test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from '../playwright.config';

test('usage dashboard shows recorded runs with table view and filters', async ({
  page,
  request,
}) => {
  // Record a run of our own: an engine test run through a tiny fake CLI.
  const work = join(process.env.AF_E2E_WORK!, 'usage');
  mkdirSync(work, { recursive: true });
  const cli = join(work, 'claude-usage');
  const line = (o: object) => JSON.stringify(o);
  const out = [
    line({ type: 'system', subtype: 'init', session_id: 's-usage', model: 'claude-haiku-5-5' }),
    line({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'OK',
      session_id: 's-usage',
      total_cost_usd: 0.002,
      usage: {},
      modelUsage: {
        'claude-haiku-5-5': {
          inputTokens: 1200,
          outputTokens: 30,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    }),
  ].join('\n');
  writeFileSync(
    cli,
    `#!/usr/bin/env node
const a = process.argv.slice(2).join(' ');
if (a.startsWith('--version')) { console.log('2.1.327'); process.exit(0); }
if (a.startsWith('auth status')) { console.log(JSON.stringify({ loggedIn: true, loginExpiresAt: '2099-01-01T00:00:00Z' })); process.exit(0); }
try { require('fs').readFileSync(0); } catch {}
process.stdout.write(${JSON.stringify(out)} + '\\n');
`,
  );
  chmodSync(cli, 0o755);
  await request.patch(`${E2E.daemonUrl}/api/engines/claude-code`, {
    data: { binaryPath: cli, enabled: true },
  });
  await request.post(`${E2E.daemonUrl}/api/engines/claude-code/refresh`);
  await request.post(`${E2E.daemonUrl}/api/engines/claude-code/test`, { data: {} });
  await expect
    .poll(
      async () =>
        (await (await request.get(`${E2E.daemonUrl}/api/usage/summary?days=1`)).json()).totals.runs,
    )
    .toBeGreaterThan(0);
  await page.goto('/usage');
  await expect(page.getByRole('heading', { name: 'Usage' })).toBeVisible();
  await expect(page.getByText('Agent runs')).toBeVisible();
  await expect(page.getByText('Tokens over time')).toBeVisible();
  await page.getByRole('button', { name: 'Show table' }).click();
  await expect(page.getByRole('columnheader', { name: 'Period' })).toBeVisible();
  await page.getByRole('radio', { name: 'cost' }).click();
  await expect(page.getByText('Cost over time')).toBeVisible();
  await expect(page.getByText('By role')).toBeVisible();
  await expect(page.getByText('Usage windows')).toBeVisible();
});

test('price table edits persist, including removals', async ({ page, request }) => {
  await page.goto('/settings');
  await page.getByLabel('New model or engine id').fill('gpt-e2e');
  await page.getByRole('button', { name: 'Add price' }).click();
  await page.getByLabel('gpt-e2e Input price').fill('2.5');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();
  let s = await (await request.get(`${E2E.daemonUrl}/api/settings`)).json();
  expect(s.pricing['gpt-e2e']).toMatchObject({ input: 2.5, output: 0 });
  await page.getByRole('button', { name: 'Remove gpt-e2e' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Settings saved').first()).toBeVisible();
  await expect
    .poll(async () => (await (await request.get(`${E2E.daemonUrl}/api/settings`)).json()).pricing)
    .toEqual({});
  s = await (await request.get(`${E2E.daemonUrl}/api/settings`)).json();
  expect(s.pricing).toEqual({});
});

test('project pipeline overrides and engine fallback', async ({ page, request }) => {
  const work = join(process.env.AF_E2E_WORK!, 'usage');
  mkdirSync(work, { recursive: true });
  const created = await request.post(`${E2E.daemonUrl}/api/projects`, {
    data: {
      mode: 'scratch',
      name: 'Fallback Demo',
      location: { kind: 'local', parentDir: work, folderName: `fb-${Date.now() % 100000}` },
    },
  });
  const projects = [await created.json()] as { id: string }[];
  await page.goto(`/projects/${projects[0]!.id}`);
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByLabel('Max fix loops').fill('2');
  await page.getByLabel('Engine fallback').click();
  await page.getByRole('button', { name: 'Save' }).last().click();
  await expect(page.getByText('Pipeline settings saved')).toBeVisible();
  const p = await (await request.get(`${E2E.daemonUrl}/api/projects/${projects[0]!.id}`)).json();
  expect(p.pipeline).toMatchObject({ maxFixLoops: 2, fallbackEnabled: true });
});
