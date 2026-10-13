import { expect, onboard, pair, test, title } from '../support/fixtures.js';

test('P3 — pair a computer: login command, pairing code, fingerprint', async ({ page, agents }) => {
  await onboard(page);
  const agent = await agents('Studio Mac');
  await pair(page, agent, 'Studio Mac');

  await expect(title(page)).toHaveText('Computers');
  await expect(page.getByText('Studio Mac')).toBeVisible();
  // Paired is past onboarding: the main app is reachable, also after a reload.
  await page.reload();
  await expect(page).toHaveURL(/\/machines$/);
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Sessions' })
    .click();
  await expect(title(page)).toHaveText('Sessions');
});
