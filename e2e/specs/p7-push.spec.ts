import { control } from '../support/control.js';
import { expect, paired, test, title } from '../support/fixtures.js';
import { dispatchPush, tapNotification } from '../support/push.js';

test('P7 — a push tap opens the request', async ({ page, context, agents }) => {
  const agent = await paired(page, agents, 'Studio Mac');
  const endpoint = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return (await registration.pushManager.getSubscription())?.endpoint;
  });
  expect(endpoint).toBeDefined();

  // The phone drops off the relay, so the agent's notice goes out as a Web Push.
  await context.setOffline(true);
  const answer = agent.fire('permission', { sessionId: 'session-p7', command: 'npm run lint' });
  answer.catch(() => undefined);
  let plaintext: string | null = null;
  await expect(async () => {
    const push = (await control.receivedPushes()).find((entry) => entry.endpoint === endpoint);
    expect(push?.plaintext).toBeTruthy();
    plaintext = push!.plaintext;
  }).toPass();

  // The push carries a sealed summary only: never the command (I1).
  expect(plaintext).not.toContain('npm run lint');
  await dispatchPush(context, plaintext!);
  await tapNotification(context);
  await expect(page).toHaveURL(/\/requests\//);
  await context.setOffline(false);
  await expect(title(page)).toHaveText('Approval request');
  await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible();
});
