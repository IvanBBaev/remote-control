import { expect, register, test, title } from '../support/fixtures.js';

test('P1 — register with a passkey, then sign in with it', async ({
  page,
  context,
  authenticator,
}) => {
  // The virtual authenticator would also answer the autofill request (05 Rec-4) at once;
  // without conditional UI, the button is the only way in.
  await context.addInitScript(() => {
    PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
  });
  const recovery = await register(page);
  expect(recovery).toMatch(/\S{16,}/);
  expect(await authenticator.credentials()).toHaveLength(1);
  await expect(title(page)).toHaveText('Install the app');

  // Signed out (no session cookie, no remembered user): the same passkey signs in.
  await context.clearCookies();
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.goto('/login');
  await expect(title(page)).toHaveText('Sign in');
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await expect(title(page)).toHaveText('Install the app');
  expect(await authenticator.credentials()).toHaveLength(1);
});
