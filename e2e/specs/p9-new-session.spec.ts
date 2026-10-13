import { expect, paired, test, title } from '../support/fixtures.js';

test('P9 — start a session from the phone', async ({ page, agents, authenticator }) => {
  const agent = await paired(page, agents, 'Studio Mac', ['shop-api']);
  const [before] = await authenticator.credentials();

  await page.goto('/new');
  await expect(title(page)).toHaveText('New session');
  await expect(page.locator('#new-machine')).toHaveValue(/.+/);
  await page.getByRole('radio', { name: 'shop-api' }).check();
  await page.locator('#new-prompt').fill('Add a health check endpoint');
  await page.getByRole('button', { name: 'Start' }).click();

  // Start is signed with the passkey (D7) and the computer runs `claude --bg` (M1-04).
  await expect(page.getByRole('link', { name: 'Open the session' })).toBeVisible();
  const [after] = await authenticator.credentials();
  expect(after!.signCount).toBeGreaterThan(before!.signCount);
  const started = (await agent.claudeRuns()).filter((run) => run.argv.includes('--bg'));
  expect(started).toHaveLength(1);
  expect(started[0]!.cwd).toMatch(/shop-api$/);
  expect(started[0]!.argv).toContain('Add a health check endpoint');
});
