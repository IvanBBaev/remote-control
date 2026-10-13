import { expect, paired, test, title } from '../support/fixtures.js';
import { openRequest } from '../support/requests.js';

test('P4 — approve a command with the passkey (UV)', async ({ page, agents, authenticator }) => {
  const agent = await paired(page, agents, 'Studio Mac');
  const { answer } = await openRequest(page, agent, 'permission', {
    sessionId: 'session-p4',
    command: 'npm test',
  });

  await expect(title(page)).toHaveText('Approval request');
  await expect(page.getByRole('heading', { level: 2 })).toHaveText('Run a command');
  await page.getByRole('button', { name: 'Show command' }).click();
  await expect(page.locator('pre.command')).toContainText('npm test');
  const signatures = (await authenticator.credentials())[0];
  await page.getByRole('button', { name: 'Allow', exact: true }).click();

  const result = await answer;
  expect(result.output).toMatchObject({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });
  await expect(page.getByText('Allowed.')).toBeVisible();
  // Allow is signed with the passkey: the authenticator's counter moved.
  const after = (await authenticator.credentials())[0];
  expect(after?.signCount).toBeGreaterThan(signatures?.signCount ?? 0);
});
