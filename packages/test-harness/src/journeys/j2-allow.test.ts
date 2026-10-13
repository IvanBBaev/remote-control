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

  it(
    "is allowed on the agent's own passkey check, with no relay `verified` flag (M2-03)",
    JOURNEY,
    async () => {
      running = await scenario({ relayCheck: false });
      const { phone, agent } = running;
      // The phone handed its passkey's public key to the agent inside the pairing handshake.
      expect(phone.passkeys).toHaveLength(1);

      const hook = agent.fire(permissionRequest(running.canaries));
      const { request } = await nextRequest(phone);
      const fetch = vi.spyOn(globalThis, 'fetch');
      await phone.decide('allow', request);
      // Nothing at the relay vouched for it: the phone never called `/api/decisions/*`.
      expect(fetch).not.toHaveBeenCalled();
      fetch.mockRestore();

      expect(await decisionResult(phone, request.id)).toMatchObject({ result: 'accepted' });
      await expect(hook).resolves.toMatchObject({
        output: {
          hookSpecificOutput: { decision: { behavior: 'allow' } },
        },
      });

      await running.assertNoLeaks();
    },
  );

  it(
    'refuses a tampered signature at the agent even when the relay vouches for it (W15)',
    JOURNEY,
    async () => {
      running = await scenario();
      const { phone, agent } = running;

      const hook = agent.fire(permissionRequest(running.canaries));
      const { request } = await nextRequest(phone);
      // The relay verifies the real assertion and forwards the decision hash; the agent
      // receives a broken signature, as a lying relay could hand it.
      await phone.decide('allow', request, null, {
        tamper: (assertion) => ({ ...assertion, signature: flipLastByte(assertion.signature) }),
      });
      expect(await decisionResult(phone, request.id)).toMatchObject({
        result: 'rejected',
        reason: 'unverified',
      });
      expect(agent.logs().some((line) => line.includes('bad_signature'))).toBe(true);

      // The request stays open: an honest assertion over a fresh decision (the relay takes
      // each decision hash once) still allows it.
      running.clock.advance(1_000);
      await phone.decide('allow', request);
      await eventually(
        () => phone.of('decision_result').filter((r) => r.requestId === request.id).length === 2,
        'phone: no second decision_result',
      );
      expect(
        phone.of('decision_result').filter((r) => r.requestId === request.id)[1],
      ).toMatchObject({ result: 'accepted' });
      await expect(hook).resolves.toMatchObject({
        output: { hookSpecificOutput: { decision: { behavior: 'allow' } } },
      });

      await running.assertNoLeaks();
    },
  );
});

/** The base64url signature with its last byte changed. */
function flipLastByte(signature: string): string {
  const bytes = Buffer.from(signature, 'base64url');
  bytes[bytes.length - 1]! ^= 0x01;
  return bytes.toString('base64url');
}
