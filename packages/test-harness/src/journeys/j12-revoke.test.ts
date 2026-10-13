import { REVOKED_CLOSE_CODE } from '@remote-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCanaries } from '../canaries.js';
import { eventually } from '../eventually.js';
import { scenario, type Scenario } from '../scenario.js';
import { JOURNEY, nextRequest, permissionRequest, userVerified } from './fixtures.js';

/** A scenario whose machine name is a canary, so every journey has one to scan for. */
async function start(): Promise<Scenario> {
  const canaries = createCanaries('CANARY');
  return scenario({ agentName: canaries.mint('MACHINE'), canaries });
}

const event = (lines: readonly string[], name: string) =>
  lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((l) => l.event === name);

describe('J12 — revocation and account deletion (M1-10)', () => {
  let running: Scenario | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it(
    '`remotectl devices revoke` drops the phone at the agent and the relay closes its socket',
    JOURNEY,
    async () => {
      running = await start();
      const { phone, agent, canaries } = running;
      const phoneId = phone.deviceId;
      // A request the phone holds when it is revoked; it stays in the terminal.
      void agent.fire(permissionRequest(canaries)).catch(() => undefined);
      const { request } = await nextRequest(phone);

      expect(await agent.devices(['revoke', phoneId])).toBe(0);
      expect(agent.stdout()).toContain(`Revoked ${phoneId}`);

      // The relay closes the phone's socket for good and tells the agent, which ends the
      // phone's session; the CLI forgot its key before asking the relay.
      await eventually(() => phone.closed !== null, 'the phone socket stayed open');
      expect(phone.closed).toEqual({ code: REVOKED_CLOSE_CODE, reason: 'revoked' });
      await eventually(
        () => event(agent.logs(), 'peer_revoked').some((l) => l.phone_device_id === phoneId),
        'the agent was not told',
      );
      expect(await agent.container.keyStore.listPeers()).toEqual([]);

      // Its login session is gone: it can neither reconnect nor run a ceremony.
      await expect(phone.connect()).rejects.toThrow();
      await expect(phone.decide('allow', request)).rejects.toThrow();
      await expect(phone.revokeDevice(running.agentDeviceId)).rejects.toThrow(/401/);

      await running.assertNoLeaks();
    },
  );

  it(
    'a phone revokes the agent: its socket closes and `run` stops reaching the relay',
    JOURNEY,
    async () => {
      running = await start();
      const { phone, agent, agentDeviceId } = running;

      await phone.revokeDevice(agentDeviceId);

      await eventually(
        () => event(agent.logs(), 'relay_revoked').length > 0,
        'the agent did not learn it was revoked',
      );
      expect(agent.stderr()).toContain('the relay revoked this machine (revoked)');
      // It forgets its phones in the background once it learns it.
      for (let round = 0; (await agent.container.keyStore.listPeers()).length > 0; round++) {
        if (round > 200) throw new Error('the agent kept its phones');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      // Unknown or already revoked: 404, nothing to tell apart.
      await expect(phone.revokeDevice(agentDeviceId)).rejects.toThrow(/404/);

      await running.assertNoLeaks();
    },
  );

  it(
    'deleting the account closes every socket and leaves no row naming the user',
    JOURNEY,
    async () => {
      running = await start();
      const { phone, agent, relay, agentDeviceId } = running;
      const { userId, deviceId: phoneId } = phone;
      expect((await relay.dump()).some((line) => line.includes(userId))).toBe(true);

      const get = vi.spyOn(phone.authenticator, 'get');
      await phone.deleteAccount();
      const assertion = await (get.mock.results[0]!.value as ReturnType<
        typeof phone.authenticator.get
      >);
      expect(userVerified(assertion.response.authenticatorData)).toBe(true);

      await eventually(() => phone.closed !== null, 'the phone socket stayed open');
      expect(phone.closed).toEqual({ code: REVOKED_CLOSE_CODE, reason: 'account_deleted' });
      await eventually(
        () => event(agent.logs(), 'relay_revoked').some((l) => l.reason === 'account_deleted'),
        'the agent socket stayed open',
      );

      // Schema-wide: no table keeps a row naming the user or any of its devices.
      await relay.idle();
      const left = (await relay.dump()).filter((line) =>
        [userId, phoneId, agentDeviceId].some((id) => line.includes(id)),
      );
      expect(left).toEqual([]);

      await running.assertNoLeaks();
    },
  );
});
