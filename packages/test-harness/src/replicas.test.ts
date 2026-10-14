import { afterEach, describe, expect, it } from 'vitest';

import { createCanaries } from './canaries.js';
import { eventually } from './eventually.js';
import { scenario, type Scenario } from './scenario.js';

const UNKNOWN_REQUEST = {
  id: '6a1c3e5f-2b4d-4f8a-9c7e-1d3f5b7a9c2e',
  requestHash: 'b'.repeat(64),
};

describe('two relay replicas (M3, ADR 0012)', () => {
  let running: Scenario | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it(
    'pairs and exchanges E2E frames with the phone and the agent on different replicas',
    { timeout: 30_000 },
    async () => {
      const canaries = createCanaries();
      const machine = canaries.mint('machine');
      running = await scenario({ agentName: machine, canaries, replicas: 2 });
      const { phone, relay, replica, agentDeviceId } = running;

      // Pairing, the session handshake and the snapshot all crossed replicas.
      expect(phone.of('snapshot')[0]?.machine.name).toBe(machine);
      // Both replicas agree on who is online.
      expect(relay.connected(phone.userId, agentDeviceId)).toBe(true);
      expect(replica?.connected(phone.userId, agentDeviceId)).toBe(true);

      const started = performance.now();
      await phone.decide('deny', UNKNOWN_REQUEST);
      await eventually(() => phone.of('decision_result').length > 0, 'no decision_result');
      // A round trip phone → relay → replica → agent and back.
      expect(performance.now() - started).toBeLessThan(200);
      expect(phone.of('decision_result')[0]).toMatchObject({ result: 'rejected' });

      await running.assertNoLeaks();
    },
  );
});
