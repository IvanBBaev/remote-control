import { expect, test, type BrowserContext } from '@playwright/test';

import { control } from '../support/control.js';
import { pair, title } from '../support/fixtures.js';
import { emulateHomeScreenApp, stubPushManager } from '../support/push.js';

// WebKit smoke (07 §5.10): WebKit has no CDP virtual authenticator, so the account is
// registered with the harness's software passkey and the browser signs in with its cookie.
async function signIn(context: BrowserContext, baseURL: string | undefined): Promise<void> {
  await context.addCookies([
    {
      name: '__Host-rc_session',
      value: await control.createAccount(),
      url: baseURL!,
      secure: true,
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
}

test('W1 — Safari in a tab: the capability probe asks to install first', async ({
  page,
  context,
  baseURL,
}) => {
  // iOS exposes PushManager only to Home Screen apps (05 F1).
  await context.addInitScript(() => {
    Reflect.deleteProperty(window, 'PushManager');
  });
  await signIn(context, baseURL);
  await page.goto('/');
  await expect(title(page)).toHaveText('Install the app');
  await expect(
    page.getByText('Notifications only work once remote-control is on your Home Screen.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue in the browser' })).toHaveCount(0);
});

test('W2 — WebKit WebCrypto: pair (XXpsk0), then read a session over KK', async ({
  page,
  context,
  baseURL,
}) => {
  await emulateHomeScreenApp(context);
  await stubPushManager(context);
  await signIn(context, baseURL);
  await page.goto('/');
  await page.getByRole('button', { name: 'Enable notifications' }).click();
  await expect(title(page)).toHaveText('Add your first computer');

  const agent = await control.startAgent('Studio Mac');
  try {
    await pair(page, agent, 'Studio Mac');
    await agent.session({
      sessionId: 'session-w2',
      name: 'fix-tests',
      prompt: 'Fix the failing test',
      answer: 'The test passes now.',
    });
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Sessions' })
      .click();
    const link = page.locator('.session-list a', { hasText: 'fix-tests' });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page.getByText('The test passes now.')).toBeVisible();
  } finally {
    await agent.close();
  }
});
