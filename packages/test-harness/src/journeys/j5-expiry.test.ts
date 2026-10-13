import { afterEach, describe, expect, it } from 'vitest';

import { createCanaries } from '../canaries.js';
import { eventually } from '../eventually.js';
import { scenario, type Scenario } from '../scenario.js';
import { decisionResult, JOURNEY, nextRequest, permissionRequest } from './fixtures.js';

/** Claude Code's hook timeout for this run, in seconds. */
const HOOK_TIMEOUT_SECONDS = 30;
/** The agent holds until `T − 10 s` (D10), then hands the request back to the terminal. */
const HOLD_MS = (HOOK_TIMEOUT_SECONDS - 10) * 1000;

describe('J5 — a request nobody answers expires back to the terminal (M0-22)', () => {
  let running: Scenario | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it(
    'hands off at `T − 10 s`, tells the phone `expired` and rejects a late decision',
    JOURNEY,
    async () => {
      running = await scenario({ canaries: createCanaries('CANARY') });
      const { phone, agent, clock, canaries } = running;

      const hook = agent.fire(permissionRequest(canaries), HOOK_TIMEOUT_SECONDS);
      const { request } = await nextRequest(phone);

      clock.advance(HOLD_MS);
      // Handoff: an empty JSON object, so Claude Code shows its own terminal prompt.
      const result = await hook;
      expect(result.stdout).toBe('{}');
      expect(result.output).toEqual({});
      await eventually(
        () => phone.of('expired').some((expired) => expired.requestId === request.id),
        'phone: no expired message',
      );

      await phone.decide('deny', request);
      expect(await decisionResult(phone, request.id)).toMatchObject({
        result: 'rejected',
        reason: 'already_resolved',
      });

      await running.assertNoLeaks();
    },
  );
});
