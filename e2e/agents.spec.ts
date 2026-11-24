import { expect, test, type APIRequestContext } from '@playwright/test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from '../playwright.config';

const WORK = join(process.env.AF_E2E_WORK!, 'agents');
const FIXTURES = join(process.cwd(), 'apps/daemon/test/fixtures/engines');
const OK = {
  loggedIn: true,
  authMethod: 'claude.ai',
  subscriptionType: 'max',
  email: 'e2e@example.com',
  loginExpiresAt: '2099-01-01T00:00:00Z',
};

/** A fake agent CLI: replays canned output chosen by argv prefix (see apps/daemon/test/fake-cli.ts). */
function fakeCli(
  name: string,
  responses: { match: string; stdout?: string; stdoutFile?: string; exitCode?: number }[],
) {
  mkdirSync(WORK, { recursive: true });
  const path = join(WORK, name);
  writeFileSync(`${path}.json`, JSON.stringify(responses));
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require('node:fs');
const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(`${path}.json`)}, 'utf8'));
if (!process.stdin.isTTY) { try { fs.readFileSync(0); } catch {} }
const key = process.argv.slice(2).join(' ');
const r = cfg.find((x) => key.startsWith(x.match)) || { exitCode: 99 };
if (r.stdoutFile) process.stdout.write(fs.readFileSync(r.stdoutFile));
if (r.stdout) process.stdout.write(r.stdout);
process.exit(r.exitCode ?? 0);
`,
  );
  chmodSync(path, 0o755);
  return path;
}

const claudeResponses = (auth: object) => [
  { match: '--version', stdout: '2.1.327 (Claude Code)' },
  { match: 'auth status', stdout: JSON.stringify(auth) },
  { match: 'auth login', stdout: 'Visit https://example.test/device and enter code E2E-OK\n' },
  { match: '-p', stdoutFile: join(FIXTURES, 'claude-success.jsonl') },
];

async function patch(request: APIRequestContext, id: string, data: object) {
  const res = await request.patch(`${E2E.daemonUrl}/api/engines/${id}`, { data });
  expect(res.ok()).toBe(true);
}

test.beforeAll(async ({ request }) => {
  const claude = fakeCli('claude', claudeResponses(OK));
  await patch(request, 'claude-code', { binaryPath: claude, enabled: true, defaultModel: null });
  for (const id of ['codex', 'gemini-cli', 'antigravity'])
    await patch(request, id, { binaryPath: join(WORK, `missing-${id}`) });
  await request.post(`${E2E.daemonUrl}/api/engines/refresh`);
  const existing = (await (await request.get(`${E2E.daemonUrl}/api/engines`)).json()) as {
    id: string;
    kind: string;
  }[];
  for (const e of existing.filter((x) => x.kind === 'custom'))
    await request.delete(`${E2E.daemonUrl}/api/engines/${e.id}`);
});

test('shows install and sign-in status for every engine', async ({ page }) => {
  await page.goto('/agents');
  const claude = page.getByRole('article', { name: 'Claude Code' });
  await expect(claude.getByText('Active', { exact: true })).toBeVisible();
  // Already signed in: no Login button.
  await expect(claude.getByRole('button', { name: 'Login' })).toHaveCount(0);
  await expect(claude.getByText('e2e@example.com')).toBeVisible();
  await expect(claude.getByText('v2.1.327')).toBeVisible();
  const codex = page.getByRole('article', { name: 'OpenAI Codex' });
  await expect(codex.getByText('Not installed')).toBeVisible();
  await expect(codex.getByText('npm install -g @openai/codex')).toBeVisible();
  await expect(codex.getByRole('button', { name: 'Login' })).toHaveCount(0);
});

test('test run streams events and shows usage windows', async ({ page }) => {
  await page.goto('/agents');
  const claude = page.getByRole('article', { name: 'Claude Code' });
  await claude.getByRole('button', { name: 'Test' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Run' }).click();
  await expect(dialog.getByText('Works — answered “DONE”')).toBeVisible();
  await expect(dialog.getByText(/^→ Bash/)).toBeVisible();
  await expect(dialog.getByText(/tokens: 1,195 in · 196 out/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(claude.getByText('5-hour window')).toBeVisible();
  await expect(claude.getByRole('progressbar', { name: '5-hour window' })).toHaveAttribute(
    'aria-valuenow',
    '43',
  );
});

test('login runs the CLI in an embedded terminal', async ({ page, request }) => {
  // Signed out: the Login button appears.
  fakeCli('claude', claudeResponses({ loggedIn: false }));
  await request.post(`${E2E.daemonUrl}/api/engines/claude-code/refresh`);
  await page.goto('/agents');
  await page
    .getByRole('article', { name: 'Claude Code' })
    .getByRole('button', { name: 'Login' })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Log in to Claude Code')).toBeVisible();
  await expect(dialog.locator('.xterm-rows')).toContainText('enter code E2E-OK');
  await expect(dialog.getByText('Login finished — status refreshed.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  fakeCli('claude', claudeResponses(OK));
  await request.post(`${E2E.daemonUrl}/api/engines/claude-code/refresh`);
});

test('an expired session raises a global banner with re-login', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByText(/session expired/)).toHaveCount(0);
  fakeCli('claude', claudeResponses({ ...OK, loginExpiresAt: '2001-01-01T00:00:00Z' }));
  await request.post(`${E2E.daemonUrl}/api/engines/claude-code/refresh`);
  const banner = page.getByRole('alert').filter({ hasText: 'Claude Code session expired' });
  await expect(banner).toBeVisible();
  await banner.getByRole('link', { name: 'Re-login' }).click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(
    page.getByRole('article', { name: 'Claude Code' }).getByRole('button', { name: 'Re-login' }),
  ).toBeVisible();
  fakeCli('claude', claudeResponses(OK));
  await request.post(`${E2E.daemonUrl}/api/engines/claude-code/refresh`);
  await expect(banner).toBeHidden();
});

test('add a custom CLI engine and pick it as a default', async ({ page }) => {
  const mine = fakeCli('mycli', [
    { match: '--version', stdout: 'mycli 1.2.3' },
    { match: 'whoami', stdout: 'dev' },
    { match: '', stdout: 'answer' },
  ]);
  await page.goto('/agents');
  await page.getByRole('button', { name: 'Custom CLI' }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Display name').fill('My CLI');
  await d.getByLabel('Id').fill('my-cli');
  await d.getByLabel('Command').fill(mine);
  await d.getByLabel('Auth check args').fill('whoami');
  await d.getByRole('button', { name: 'Add engine' }).click();
  const card = page.getByRole('article', { name: 'My CLI' });
  await expect(card.getByText('Active', { exact: true })).toBeVisible();
  await expect(card.getByText('v1.2.3')).toBeVisible();

  await page.goto('/settings');
  await page.getByRole('combobox', { name: 'Reviewer' }).click();
  await page.getByRole('option', { name: /My CLI/ }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();
  await page.getByRole('combobox', { name: 'Reviewer' }).click();
  await page.getByRole('option', { name: /Claude Code/ }).click();
  await page.getByRole('button', { name: 'Save' }).click();
});
