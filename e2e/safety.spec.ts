import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { E2E } from '../playwright.config';

const FAKE = join(process.cwd(), 'apps/daemon/test/fixtures/fake-claude-guarded.mjs');

test('risky agent commands wait for approval; catastrophic ones are blocked', async ({
  page,
  request,
}) => {
  await request.patch(`${E2E.daemonUrl}/api/engines/claude-code`, {
    data: { binaryPath: FAKE, enabled: true },
  });
  await request.post(`${E2E.daemonUrl}/api/engines/claude-code/refresh`);
  await page.goto('/');

  const started = await request.post(`${E2E.daemonUrl}/api/engines/claude-code/test`, {
    data: { prompt: 'RUN: cat .env\nRUN: rm -rf ~' },
  });
  expect(started.status()).toBe(202);

  const card = page.getByTestId('safety-approval');
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card).toContainText('An agent wants to run a command');
  await expect(card).toContainText('cat .env');
  await expect(card).toContainText('Reads or writes a file that may contain secrets');
  await card.getByRole('button', { name: 'Allow once' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByText('Blocked an agent action')).toBeVisible();

  const log = await (await request.get(`${E2E.daemonUrl}/api/safety/approvals`)).json();
  expect(
    log.slice(0, 2).map((a: { summary: string; status: string }) => [a.summary, a.status]),
  ).toEqual([
    ['rm -rf ~', 'blocked'],
    ['cat .env', 'approved'],
  ]);
  // Approvals can only be answered from the app, not by scripts.
  const direct = await request.post(`${E2E.daemonUrl}/api/safety/approvals/${log[1].id}`, {
    data: { decision: 'approve' },
  });
  expect(direct.status()).toBe(403);
});
