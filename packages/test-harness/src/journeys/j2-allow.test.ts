import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCanaries } from '../canaries.js';
import { eventually } from '../eventually.js';
import { scenario, type Scenario } from '../scenario.js';
import {
  decisionResult,
  JOURNEY,
  JOURNEY_SESSION_ID,
  nextRequest,
  permissionRequest,
  userVerified,
} from './fixtures.js';

/** The relay's "phone did not ack the `cls: request`" window (03 §5.12), on the fake clock. */
const UNACKED_PUSH_MS = 3_000;

describe('J2 — PermissionRequest allowed with a user-verifying passkey (M0-22)', () => {
  let running: Scenario | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it(
    'delivers the request E2E, pushes metadata only and answers Claude Code `allow`',
    JOURNEY,
    async () => {
      running = await scenario({ canaries: createCanaries('CANARY') });
      const { phone, agent, relay, clock, canaries } = running;
      const input = permissionRequest(canaries);

      const hook = agent.fire(input);
      const { request, ttlMs } = await nextRequest(phone);
      expect(request).toMatchObject({ sessionId: JOURNEY_SESSION_ID });
      // The phone decrypts the full tool input; the canaries in it are the gate's probes.
      expect(JSON.stringify(request)).toContain(
        (input['tool_input'] as { command: string }).command,
      );
      expect(ttlMs).toBeGreaterThan(0);

      // Unacked on the open socket: the relay rings the phone with metadata and the agent's
      // sealed summary (M1-06), which it cannot read.
      clock.advance(UNACKED_PUSH_MS);
      await eventually(() => relay.push.received.length > 0, 'no push');
      expect(relay.push.received).toHaveLength(1);
      const [push] = relay.push.received;
      expect(push!.rejected).toBeNull();
      expect(JSON.parse(push!.plaintext!)).toEqual({
        t: 'pending',
        // The relay names the sealed envelope it holds; the request id is inside the seal.
        rid: expect.not.stringMatching(request.id) as unknown,
        dev: 'harness-agent',
        exp: expect.any(Number) as unknown,
        sum: expect.any(String) as unknown,
      });

      const get = vi.spyOn(phone.authenticator, 'get');
      await phone.decide('allow', request);
      // A real assertion ran at the relay, and it was user-verifying (D7).
      expect(get).toHaveBeenCalledOnce();
      const assertion = await (get.mock.results[0]!.value as ReturnType<
        typeof phone.authenticator.get
      >);
      expect(userVerified(assertion.response.authenticatorData)).toBe(true);

      expect(await decisionResult(phone, request.id)).toMatchObject({ result: 'accepted' });
      const result = await hook;
      expect(result.output).toEqual({
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
      });

      await running.assertNoLeaks();
    },
  );
});
