import { writeFile } from 'node:fs/promises';

import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';

import { withVirtualAuthenticator, type VirtualAuthenticator } from './authenticator.js';
import { control, type ControlAgent } from './control.js';
import { stubPushManager } from './push.js';

export { expect };

export interface Fixtures {
  /** The phone's passkey: a user-verifying virtual authenticator on `page`. */
  authenticator: VirtualAuthenticator;
  /** Starts harness agents; every one is closed after the test. */
  agents: (name: string, repositories?: readonly string[]) => Promise<ControlAgent>;
}

export const test = base.extend<Fixtures>({
  authenticator: [
    async ({ page }, use) => {
      await use(await withVirtualAuthenticator(page));
    },
    { auto: true },
  ],
  context: async ({ context }, use) => {
    await stubPushManager(context);
    await use(context);
  },
  // Playwright reads the fixtures a fixture needs from its first parameter's pattern.
  // eslint-disable-next-line no-empty-pattern
  agents: async ({}, use, testInfo) => {
    const started: ControlAgent[] = [];
    await use(async (name, repositories) => {
      const agent = await control.startAgent(name, repositories);
      started.push(agent);
      return agent;
    });
    if (testInfo.status !== testInfo.expectedStatus) {
      for (const [index, agent] of started.entries()) {
        const { lines, stderr, relay } = await agent.logs();
        const path = testInfo.outputPath(`agent-${String(index)}.log`);
        await writeFile(
          path,
          [...lines, '--- stderr ---', stderr, '--- relay ---', ...relay].join('\n'),
        );
        await testInfo.attach(`agent-${String(index)}.log`, { path, contentType: 'text/plain' });
      }
    }
    await Promise.all(started.map((agent) => agent.close()));
  },
});

/** The screen title (every screen's `h1`). */
export const title = (page: Page) => page.getByRole('heading', { level: 1 });

/**
 * P1's path (docs/product/screens.md, "End-to-end hooks"): a fresh invite, **Create
 * passkey**, the recovery code confirmed. Returns the recovery code shown.
 */
export async function register(page: Page): Promise<string> {
  const invite = await control.mintInvite();
  await page.goto(`/onboarding/passkey?invite=${encodeURIComponent(invite)}`);
  await page.getByRole('button', { name: 'Create passkey' }).click();
  const recovery = page.getByLabel('Recovery code', { exact: true });
  await expect(recovery).toBeVisible();
  const code = (await recovery.textContent()) ?? '';
  await page.getByLabel('I saved my recovery code somewhere safe').check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  return code.trim();
}

/** The user's "Allow" on the permission prompt the next **Enable notifications** opens. */
export async function allowNotifications(context: BrowserContext): Promise<void> {
  await context.grantPermissions(['notifications']);
}

/** Registers, skips installing (Chromium has Web Push in a tab) and grants notifications. */
export async function onboard(page: Page): Promise<void> {
  await register(page);
  await page.getByRole('button', { name: 'Continue in the browser' }).click();
  await allowNotifications(page.context());
  await page.getByRole('button', { name: 'Enable notifications' }).click();
  await expect(title(page)).toHaveText('Add your first computer');
}

/**
 * P3's path from the pairing screen: enrol a computer, `remotectl login` with the command
 * shown, `remotectl pair`, type its code, confirm the fingerprint, then `remotectl run`.
 */
export async function pair(page: Page, agent: ControlAgent, name: string): Promise<void> {
  await page.getByLabel('Computer name').fill(name);
  await page.getByRole('button', { name: 'Get the login command' }).click();
  const command = page.locator('pre.command', { hasText: 'remotectl login' });
  await expect(command).toBeVisible();
  await agent.login((await command.textContent()) ?? '');
  const code = await agent.pair();
  await page.getByLabel('Pairing code').fill(code);
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByLabel('Pairing fingerprint')).not.toBeEmpty();
  await agent.paired();
  await page.getByRole('button', { name: 'The codes match' }).click();
  await expect(page).toHaveURL(/\/machines$/);
  await agent.run();
}

/** Onboarding and one paired, running computer named `name`. */
export async function paired(
  page: Page,
  agents: Fixtures['agents'],
  name: string,
  repositories: readonly string[] = [],
): Promise<ControlAgent> {
  await onboard(page);
  const agent = await agents(name, repositories);
  await pair(page, agent, name);
  return agent;
}
