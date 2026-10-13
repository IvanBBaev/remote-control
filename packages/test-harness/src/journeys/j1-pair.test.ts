import { toBase64Url } from '@remote-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { createCanaries } from '../canaries.js';
import { scenario, type Scenario } from '../scenario.js';
import { JOURNEY } from './fixtures.js';

describe('J1 — register, passkey and pair (M0-22)', () => {
  let running: Scenario | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it(
    "pairs phone and agent on each other's static keys; the relay keeps only ids",
    JOURNEY,
    async () => {
      const canaries = createCanaries('CANARY');
      // The machine name travels only inside the pairing and session handshakes.
      const machine = canaries.mint('MACHINE');
      running = await scenario({ agentName: machine, canaries });
      const { phone, agent, relay } = running;

      expect(phone.authenticator.credentialCount).toBe(1);
      // Each side holds the other's static key: the phone from XXpsk0, the agent in its peers.
      expect(running.agentPublicKey).toEqual(await agent.publicKey());
      const peers = await agent.container.keyStore.listPeers();
      expect(peers).toEqual([
        expect.objectContaining({
          deviceId: phone.deviceId,
          publicKey: toBase64Url(phone.keyPair.publicKey),
        }),
      ]);
      expect(phone.of('snapshot')[0]).toMatchObject({ machine: { name: machine }, pending: [] });

      // The relay knows both devices by id; the machine name never reaches it (gate below).
      const dump = (await relay.dump()).join('\n');
      expect(dump).toContain(phone.deviceId);
      expect(dump).toContain(running.agentDeviceId);

      await running.assertNoLeaks();
    },
  );
});
