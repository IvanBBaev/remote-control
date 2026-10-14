import { webCryptoRandom } from '@remote-control/crypto';
import { createLogger, createMemoryDestination } from '@remote-control/log';
import { describe, expect, it, vi } from 'vitest';

import { systemClock } from './system-clock.js';
import { systemTimer } from './system-timer.js';
import { PgNotifyHub } from '../core/pg-notify-hub.js';
import type { DeviceIdentity } from '../ports/device-directory.js';
import type { HubConnection } from '../ports/hub.js';
import { createPgNotifyBus } from './pg-notify-bus.js';

// Real Postgres (vitest project `pg-real`): two hubs, each with its own LISTEN and
// NOTIFY connections, as two relay replicas would have (ADR 0012).
const url = process.env['RC_TEST_DATABASE_URL'];

const phone: DeviceIdentity = {
  userId: '11111111-1111-4111-8111-111111111111',
  deviceId: '33333333-3333-4333-8333-333333333333',
  kind: 'phone',
};

async function until(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 100 && !condition(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(condition()).toBe(true);
}

describe.skipIf(url === undefined)('PgNotifyHub on real Postgres', () => {
  it('shares a device and delivers a chunked frame between two replicas', async () => {
    const logs = createMemoryDestination();
    const logger = createLogger({ level: 'info', destination: logs });
    const hub = () =>
      new PgNotifyHub({
        clock: systemClock,
        timer: systemTimer,
        random: webCryptoRandom,
        bus: createPgNotifyBus(url!, logger),
        logger,
        deviceCap: 10,
      });
    const a = hub();
    const b = hub();
    await a.start();
    await b.start();
    try {
      const send = vi.fn<HubConnection['send']>(() => true);
      const socket: HubConnection = { identity: phone, send, close: vi.fn() };
      a.attach(socket);
      await until(() => b.connection(phone.userId, phone.deviceId) !== undefined);
      const large = JSON.stringify({ payload: 'ж'.repeat(20_000) });
      b.connection(phone.userId, phone.deviceId)?.send(large);
      await until(() => send.mock.calls.length === 1);
      expect(send.mock.calls[0]).toEqual([large]);
    } finally {
      await a.stop();
      await b.stop();
    }
    expect(logs.lines().join('\n')).not.toContain('hub_publish_failed');
  });
});
