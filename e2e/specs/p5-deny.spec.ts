import { expect, paired, test, title } from '../support/fixtures.js';
import { openRequest } from '../support/requests.js';

test('P5 — deny a command', async ({ page, agents }) => {
  const agent = await paired(page, agents, 'Studio Mac');
  const { answer } = await openRequest(page, agent, 'permission', {
    sessionId: 'session-p5',
    command: 'rm -rf build',
  });

  await expect(title(page)).toHaveText('Approval request');
  await page.getByRole('button', { name: 'Deny', exact: true }).click();

  const result = await answer;
  expect(result.output).toMatchObject({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } },
  });
  await expect(page.getByText('Denied.')).toBeVisible();
});
