import { afterEach, describe, expect, it } from 'vitest';

import { createCanaries } from './canaries.js';
import { eventually } from './eventually.js';
import { scenario, type Scenario } from './scenario.js';

const UNKNOWN_REQUEST = {
  id: '0b5f2a8e-4c1d-4e7a-9f3b-2d6c8a1e5f70',
  requestHash: 'a'.repeat(64),
};

describe('harness smoke (M0-17)', () => {
  let running: Scenario | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it(
    'pairs the headless phone with the in-process agent and exchanges E2E frames',
    {
      timeout: 30_000,
    },
    async () => {
      const started = performance.now();
      const canaries = createCanaries();
      // The machine name travels only inside the pairing and session handshakes.
      const machine = canaries.mint('machine');
      running = await scenario({ agentName: machine, canaries });
      const { phone } = running;

      expect(phone.of('snapshot')[0]?.machine.name).toBe(machine);

      await phone.decide('deny', UNKNOWN_REQUEST);
      await eventually(() => phone.of('decision_result').length > 0, 'no decision_result');
      expect(phone.of('decision_result')).toEqual([
        {
          t: 'decision_result',
          requestId: UNKNOWN_REQUEST.id,
          result: 'rejected',
          reason: 'unknown_request',
        },
      ]);
      // The AC budget: registration, pairing, the session and the exchange; booting the
      // relay's database is fixture cost.
      expect(performance.now() - started - running.bootMs).toBeLessThan(5000);

      await running.assertNoLeaks();
    },
  );
});
