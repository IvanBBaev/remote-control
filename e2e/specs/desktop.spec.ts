import { expect, paired, test, title } from '../support/fixtures.js';
import { openRequest } from '../support/requests.js';

test('D1 — sessions list and detail side by side at 1280 px', async ({ page, agents }) => {
  const agent = await paired(page, agents, 'Studio Mac');
  await page.goto('/sessions');
  await expect(title(page)).toHaveText('Sessions');
  await agent.session({
    sessionId: 'session-d1a',
    name: 'fix-tests',
    prompt: 'Fix the failing test',
    answer: 'The test passes now.',
  });
  await agent.session({
    sessionId: 'session-d1b',
    name: 'write-docs',
    prompt: 'Document the API',
    answer: 'Done.',
  });

  const list = page.getByRole('navigation', { name: 'Sessions' });
  await expect(list.getByRole('link', { name: /write-docs/ })).toBeVisible();
  await expect(page.getByText('Pick a session on the left')).toBeVisible();

  await list.getByRole('link', { name: /fix-tests/ }).click();
  await expect(title(page)).toHaveText('fix-tests');
  await expect(page.getByText('Fix the failing test')).toBeVisible();
  // Both panes stay on screen, next to each other.
  const listBox = await list.boundingBox();
  const detailBox = await title(page).boundingBox();
  expect(listBox && detailBox && listBox.x + listBox.width <= detailBox.x).toBe(true);
  await expect(list.getByRole('link', { name: /fix-tests/ })).toHaveAttribute(
    'aria-current',
    'page',
  );

  // Keyboard navigation between the panes: the list links are reachable without a mouse.
  await list.getByRole('link', { name: /write-docs/ }).focus();
  await page.keyboard.press('Enter');
  await expect(title(page)).toHaveText('write-docs');
});

test('D2 — the A key allows, still with the passkey (UV)', async ({
  page,
  agents,
  authenticator,
}) => {
  const agent = await paired(page, agents, 'Studio Mac');
  const { answer } = await openRequest(page, agent, 'permission', {
    sessionId: 'session-d2',
    command: 'npm test',
  });

  await expect(page.getByRole('navigation', { name: 'Sessions' })).toBeVisible();
  await expect(page.getByText('Your passkey still confirms')).toBeVisible();
  const signatures = (await authenticator.credentials())[0];
  await page.keyboard.press('a');

  const result = await answer;
  expect(result.output).toMatchObject({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });
  await expect(page.getByText('Allowed.')).toBeVisible();
  const after = (await authenticator.credentials())[0];
  expect(after?.signCount).toBeGreaterThan(signatures?.signCount ?? 0);
});
