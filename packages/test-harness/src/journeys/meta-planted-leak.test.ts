import { afterEach, describe, expect, it } from 'vitest';

import { createCanaries } from '../canaries.js';
import { eventually } from '../eventually.js';
import { PrivacyLeakError } from '../privacy-gate.js';
import { scenario, type Scenario } from '../scenario.js';
import { JOURNEY, nextRequest, permissionRequest } from './fixtures.js';

/** The relay's "phone did not ack the `cls: request`" window (03 §5.12), on the fake clock. */
const UNACKED_PUSH_MS = 3_000;

describe('privacy gate meta-test — a planted leak fails the run (M0-22)', () => {
  let running: Scenario | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it('catches a canary the relay legitimately stores and pushes', JOURNEY, async () => {
    const canaries = createCanaries('CANARY');
    // The enrol name is metadata the relay keeps and puts in the push (`dev`): planting a
    // canary there is a leak by construction, in the database row and in the push.
    const planted = canaries.mint('PLANTED');
    running = await scenario({ enrolName: planted, canaries });
    const { phone, agent, relay, clock } = running;

    const hook = agent.fire(permissionRequest(canaries));
    await nextRequest(phone);
    clock.advance(UNACKED_PUSH_MS);
    await eventually(() => relay.push.received.length > 0, 'no push');

    const error = await running.assertNoLeaks().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PrivacyLeakError);
    const leaks = (error as PrivacyLeakError).leaks;
    expect(new Set(leaks.map((leak) => leak.canary))).toEqual(new Set([planted]));
    expect(new Set(leaks.map((leak) => leak.source))).toEqual(new Set(['pglite', 'push']));

    // Let the hold end so `close` does not race an open hook call.
    await phone.decide('deny', (await nextRequest(phone)).request);
    await hook;
  });
});
