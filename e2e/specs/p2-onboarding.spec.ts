import { allowNotifications, expect, register, test, title } from '../support/fixtures.js';

test('P2 — onboarding gates the app: passkey, install, notifications, pair', async ({
  page,
  context,
}) => {
  // Nothing is reachable before the passkey step.
  await page.goto('/sessions');
  await expect(page).toHaveURL(/\/onboarding\/passkey$/);
  await expect(title(page)).toHaveText('Create your passkey');

  await register(page);
  await expect(page).toHaveURL(/\/onboarding\/install$/);
  // Chromium has Web Push in a tab, so installing is optional; the choice survives a reload.
  await page.goto('/sessions');
  await expect(page).toHaveURL(/\/onboarding\/install$/);
  await page.getByRole('button', { name: 'Continue in the browser' }).click();
  await expect(page).toHaveURL(/\/onboarding\/notifications$/);
  await page.reload();

  await expect(page).toHaveURL(/\/onboarding\/notifications$/);
  await page.goto('/machines');
  await expect(page).toHaveURL(/\/onboarding\/notifications$/);
  await allowNotifications(context);
  await page.getByRole('button', { name: 'Enable notifications' }).click();

  await expect(page).toHaveURL(/\/onboarding\/pair$/);
  await expect(title(page)).toHaveText('Add your first computer');
  await page.goto('/sessions');
  await expect(page).toHaveURL(/\/onboarding\/pair$/);
});
