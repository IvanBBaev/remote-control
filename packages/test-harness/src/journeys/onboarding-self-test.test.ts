import { afterEach, describe, expect, it } from 'vitest';

import type { Canaries } from '../canaries.js';
import { scenario, type Scenario } from '../scenario.js';
import { JOURNEY, nextRequest } from './fixtures.js';

/** The session id `remotectl status --self-test` sends its request under (M1-07). */
const SELF_TEST_SESSION_ID = 'remotectl-self-test';

/**
 * The self-test's command is fixed, so its text is the privacy gate's probe: the relay
 * must never see `echo "remotectl self-test"` in plaintext.
 */
const SELF_TEST_CANARIES: Canaries = {
  mint: () => {
    throw new Error('the self-test journey mints no canaries');
  },
  all: () => ['echo "remotectl self-test"'],
};

describe('Onboarding self-test (M1-07, 01 W8)', () => {
  let running: Scenario | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it(
    'sends a test request through the hook path and reports the phone’s answer',
    JOURNEY,
    async () => {
      running = await scenario({ canaries: SELF_TEST_CANARIES });
      const { phone, agent } = running;

      const status = agent.status(['--self-test']);
      const { request } = await nextRequest(phone);
      expect(request).toMatchObject({ sessionId: SELF_TEST_SESSION_ID, toolName: 'Bash' });
      expect(request.content).toContain(SELF_TEST_CANARIES.all()[0]);
      await phone.decide('allow', request);

      expect(await status).toBe(0);
      expect(agent.stdout()).toContain('[ok] Is the agent running?');
      expect(agent.stdout()).toContain('self-test: ok — the phone answered allow.');
      // The self-test is not a session: the phone never lists it.
      expect(
        phone.of('snapshot').flatMap((snapshot) => snapshot.sessions.map((session) => session.id)),
      ).not.toContain(SELF_TEST_SESSION_ID);

      await running.assertNoLeaks();
    },
  );
});
