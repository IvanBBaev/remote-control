import { expect, paired, test, title } from '../support/fixtures.js';

test('P8 — a running session and its feed', async ({ page, agents }) => {
  const agent = await paired(page, agents, 'Studio Mac');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Sessions' })
    .click();
  await expect(title(page)).toHaveText('Sessions');

  await agent.session({
    sessionId: 'session-p8',
    name: 'fix-tests',
    prompt: 'Fix the failing test',
    answer: 'The test passes now.',
  });

  // The roster reaches the phone with the next snapshot.
  const link = page.locator('.session-list a', { hasText: 'fix-tests' });
  await expect(link).toBeVisible();
  await link.click();
  await expect(title(page)).toHaveText('fix-tests');
  await expect(page.getByText('Fix the failing test')).toBeVisible();
  await expect(page.getByText('The test passes now.')).toBeVisible();
});
