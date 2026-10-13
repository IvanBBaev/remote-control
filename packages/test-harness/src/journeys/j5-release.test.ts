import { afterEach, describe, expect, it } from 'vitest';

import { createCanaries } from '../canaries.js';
import { eventually } from '../eventually.js';
import { scenario, type Scenario } from '../scenario.js';
import {
  decisionResult,
  JOURNEY,
  nextQuestion,
  nextRequest,
  permissionRequest,
  questionRequest,
} from './fixtures.js';

/** "Reply in terminal" must reach Claude Code's own prompt quickly (M1-03 AC). */
const RELEASE_BUDGET_MS = 1000;

describe('J5 variant — "Reply in terminal" from the phone (M1-03)', () => {
  let running: Scenario | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it(
    'AC: releases a permission request to the terminal within 1 s as a handoff, not a decision',
    JOURNEY,
    async () => {
      running = await scenario({ canaries: createCanaries('CANARY') });
      const { phone, agent, canaries } = running;

      const hook = agent.fire(permissionRequest(canaries), 30);
      const { request } = await nextRequest(phone);

      const started = performance.now();
      // `terminal` needs no WebAuthn ceremony (D7): the harness phone skips it.
      await phone.decide('terminal', request);
      const result = await hook;
      const elapsed = performance.now() - started;

      // Handoff (D10): an empty object, neither an allow nor a deny.
      expect(result.stdout).toBe('{}');
      expect(result.output).toEqual({});
      expect(elapsed).toBeLessThan(RELEASE_BUDGET_MS);
      expect(await decisionResult(phone, request.id)).toMatchObject({ result: 'accepted' });

      // The release was final: a later decision loses (D25).
      await phone.decide('deny', request);
      const results = () => phone.of('decision_result').filter((r) => r.requestId === request.id);
      await eventually(() => results().length === 2, 'phone: no second decision_result');
      expect(results()[1]).toMatchObject({ result: 'rejected', reason: 'already_resolved' });

      await running.assertNoLeaks();
    },
  );

  it('releases a question to the terminal with no answer', JOURNEY, async () => {
    running = await scenario({ canaries: createCanaries('CANARY') });
    const { phone, agent, canaries } = running;

    const hook = agent.fire(questionRequest(canaries), 30);
    const { question } = await nextQuestion(phone);

    const started = performance.now();
    await phone.decide('terminal', question);
    const result = await hook;
    expect(performance.now() - started).toBeLessThan(RELEASE_BUDGET_MS);
    expect(result.stdout).toBe('{}');
    expect(result.output).toEqual({});
    expect(await decisionResult(phone, question.id)).toMatchObject({ result: 'accepted' });

    await running.assertNoLeaks();
  });
});
