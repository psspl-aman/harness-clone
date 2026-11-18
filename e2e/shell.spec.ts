import { expect, test } from '@playwright/test';
import { E2E } from '../playwright.config';

test.beforeEach(async ({ request }) => {
  // Reset settings touched by tests to defaults.
  await request.patch(`${E2E.daemonUrl}/api/settings`, {
    data: { pipeline: { maxFixLoops: 3, requireHumanReviewBeforeMerge: false } },
  });
});

test('shell loads, connects live and shows the empty dashboard', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Daemon connection: Live' })).toBeVisible();
  await expect(page.getByText('No projects yet')).toBeVisible();
});

test('command palette navigates and keyboard shortcuts work', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('status', { name: 'Daemon connection: Live' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder('Type a command or search…').fill('settings');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.keyboard.press('g');
  await page.keyboard.press('p');
  await expect(page).toHaveURL(/\/$/);
});

test('settings save persists and validates', async ({ page, request }) => {
  await page.goto('/settings');
  const loops = page.getByLabel('Max fix loops per task');
  await expect(loops).toHaveValue('3');

  await loops.fill('42');
  await expect(page.getByText(/pipeline\.maxFixLoops/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

  await loops.fill('5');
  await page.getByRole('switch', { name: 'Require my review before merge' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();
  await expect(page.getByText('Unsaved changes')).toBeHidden();

  const saved = await (await request.get(`${E2E.daemonUrl}/api/settings`)).json();
  expect(saved.pipeline).toMatchObject({ maxFixLoops: 5, requireHumanReviewBeforeMerge: true });

  await page.reload();
  await expect(page.getByLabel('Max fix loops per task')).toHaveValue('5');
});

test('changes made elsewhere stream into the open page', async ({ page, request }) => {
  await page.goto('/settings');
  await expect(page.getByRole('status', { name: 'Daemon connection: Live' })).toBeVisible();
  await expect(page.getByLabel('Max fix loops per task')).toHaveValue('3');
  await request.patch(`${E2E.daemonUrl}/api/settings`, { data: { pipeline: { maxFixLoops: 7 } } });
  await expect(page.getByLabel('Max fix loops per task')).toHaveValue('7');
});

test('theme toggle switches to dark mode', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Change theme' }).click();
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
});
