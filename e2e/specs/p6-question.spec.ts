import { expect, paired, test, title } from '../support/fixtures.js';
import { openRequest } from '../support/requests.js';

const QUESTION = 'Which framework?';

test('P6 — answer a question from the agent', async ({ page, agents }) => {
  const agent = await paired(page, agents, 'Studio Mac');
  const { answer } = await openRequest(page, agent, 'question', {
    sessionId: 'session-p6',
    questions: [
      {
        question: QUESTION,
        header: 'Framework',
        options: [
          { label: 'React', description: 'Component library' },
          { label: 'Vue', description: 'Progressive framework' },
        ],
        multiSelect: false,
      },
    ],
  });

  await expect(title(page)).toHaveText('Question');
  await expect(page.getByText(QUESTION)).toBeVisible();
  await page.getByRole('radio', { name: /Vue/ }).check();
  await page.getByRole('button', { name: 'Send answer' }).click();

  const result = await answer;
  expect(result.output).toMatchObject({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { answers: { [QUESTION]: 'Vue' } },
    },
  });
  await expect(page.getByText('Answered.')).toBeVisible();
});
