import { encodeAnswerPayload } from '@remote-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCanaries } from '../canaries.js';
import { scenario, type Scenario } from '../scenario.js';
import {
  decisionResult,
  JOURNEY,
  JOURNEY_SESSION_ID,
  nextQuestion,
  nextRequest,
  permissionRequest,
  questionRequest,
  userVerified,
} from './fixtures.js';

interface AskedQuestion {
  readonly question: string;
  readonly options: readonly { readonly label: string }[];
}

/** The questions of a `questionRequest` hook input, as Claude Code sent them. */
function asked(input: Readonly<Record<string, unknown>>): readonly AskedQuestion[] {
  return (input['tool_input'] as { questions: readonly AskedQuestion[] }).questions;
}

describe('J4 — AskUserQuestion answered from the phone (M1-01)', () => {
  let running: Scenario | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it(
    'shows the questions E2E and answers Claude Code with the questions and the answers',
    JOURNEY,
    async () => {
      running = await scenario({ canaries: createCanaries('CANARY') });
      const { phone, agent, canaries } = running;
      const input = questionRequest(canaries);
      const [framework, checks] = asked(input);

      const hook = agent.fire(input);
      const { question, ttlMs } = await nextQuestion(phone);
      expect(ttlMs).toBeGreaterThan(0);
      expect(question).toMatchObject({
        sessionId: JOURNEY_SESSION_ID,
        questions: [
          { text: framework!.question, multi: false },
          { text: checks!.question, multi: true },
        ],
      });
      // The phone decrypts every question text, header, label and description.
      for (const canary of canaries.all().filter((value) => !/PATH|CWD/.test(value))) {
        expect(JSON.stringify(question)).toContain(canary);
      }

      const answer = {
        answers: [
          { labels: [framework!.options[1]!.label] },
          { labels: checks!.options.map((option) => option.label), other: 'e2e' },
        ],
        response: 'Thanks',
      };
      const get = vi.spyOn(phone.authenticator, 'get');
      await phone.decide('answer', question, encodeAnswerPayload(answer));
      // An answer is signed by a user-verifying passkey, like `allow` (D7).
      expect(get).toHaveBeenCalledOnce();
      const assertion = await (get.mock.results[0]!.value as ReturnType<
        typeof phone.authenticator.get
      >);
      expect(userVerified(assertion.response.authenticatorData)).toBe(true);

      expect(await decisionResult(phone, question.id)).toMatchObject({ result: 'accepted' });
      expect((await hook).output).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: {
            questions: asked(input),
            answers: {
              [framework!.question]: framework!.options[1]!.label,
              [checks!.question]: `${checks!.options[0]!.label}, ${checks!.options[1]!.label}, e2e`,
            },
            response: 'Thanks',
          },
        },
      });

      await running.assertNoLeaks();
    },
  );

  it('refuses an answer that does not fit, then denies the question', JOURNEY, async () => {
    running = await scenario({ canaries: createCanaries('CANARY') });
    const { phone, agent, canaries } = running;

    const hook = agent.fire(questionRequest(canaries));
    const { question } = await nextQuestion(phone);
    // One answer for two questions: the agent refuses it and keeps the question open.
    await phone.decide(
      'answer',
      question,
      encodeAnswerPayload({ answers: [{ labels: [], other: 'Svelte' }] }),
    );
    expect(await decisionResult(phone, question.id)).toMatchObject({
      result: 'rejected',
      reason: 'invalid_answer',
    });

    await phone.decide('deny', question);
    await expect(hook).resolves.toMatchObject({
      output: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Denied from phone',
        },
      },
    });

    await running.assertNoLeaks();
  });

  it('rejects an answer decision for a Bash request (wrong_kind)', JOURNEY, async () => {
    running = await scenario({ canaries: createCanaries('CANARY') });
    const { phone, agent, canaries } = running;

    const hook = agent.fire(permissionRequest(canaries));
    const { request } = await nextRequest(phone);
    await phone.decide('answer', request, encodeAnswerPayload({ answers: [{ labels: ['Bash'] }] }));
    expect(await decisionResult(phone, request.id)).toMatchObject({
      result: 'rejected',
      reason: 'wrong_kind',
    });

    // The request is still open: the phone can still decide it.
    await phone.decide('deny', request);
    const { stdout } = await hook;
    expect(stdout).not.toContain('updatedInput');
    expect(JSON.parse(stdout)).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } },
    });

    await running.assertNoLeaks();
  });
});
