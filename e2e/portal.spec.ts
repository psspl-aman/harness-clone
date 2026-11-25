import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from '../playwright.config';

test('welcome and the portal link to each other', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Welcome', exact: true }).click();
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('merged code');
  await page.getByRole('link', { name: 'Open portal', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
});

test('project search, list preference and mobile workspace navigation use live projects', async ({
  page,
  request,
}) => {
  const work = process.env.AF_E2E_WORK!;
  mkdirSync(work, { recursive: true });
  const parentDir = mkdtempSync(join(work, 'portal-'));
  const response = await request.post(`${E2E.daemonUrl}/api/projects`, {
    data: {
      mode: 'scratch',
      name: 'Portal layout QA',
      location: { kind: 'local', parentDir, folderName: 'portal-layout' },
    },
  });
  expect(response.ok()).toBe(true);
  const { id } = (await response.json()) as { id: string };

  try {
    await page.goto('/');
    const main = page.getByRole('main');
    const filter = main.getByRole('searchbox', { name: 'Filter projects' });
    const project = main.getByRole('link', { name: 'Portal layout QA' });
    await expect(project).toBeVisible();
    await filter.fill('no-such-portal-project');
    await expect(project).toBeHidden();
    await expect(main.getByText('No matching projects')).toBeVisible();
    await filter.fill('portal-layout');
    await expect(project).toBeVisible();

    const display = main.getByRole('group', { name: 'Project display' });
    const list = display.getByRole('button', { name: 'List' });
    await list.click();
    await page.reload();
    await expect(list).toHaveAttribute('aria-pressed', 'true');

    await page.setViewportSize({ width: 390, height: 844 });
    await project.click();
    await expect(main.getByRole('heading', { name: 'Portal layout QA', level: 1 })).toBeVisible();
    const workspace = main.getByRole('tablist', { name: 'Workspace' });
    await workspace.getByRole('tab', { name: 'Chat', exact: true }).click();
    await expect(main.getByRole('textbox', { name: 'Message the Planner' })).toBeVisible();
    await workspace.getByRole('tab', { name: 'Overview', exact: true }).click();
    await expect(workspace.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await expect(main.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  } finally {
    await request.delete(`${E2E.daemonUrl}/api/projects/${id}`);
  }
});
