import { webCryptoRandom } from '@remote-control/crypto';
import { createLogger, createMemoryDestination } from '@remote-control/log';
import { describe, expect, it, vi } from 'vitest';

import type { DeviceDirectory, DeviceIdentity } from '../ports/device-directory.js';
import type { HubPort } from '../ports/hub.js';
import type { PeerSocket } from '../ports/peer-socket.js';
import type { PendingRequestSink } from '../ports/relay-seams.js';
import { createFakeTime, type FakeTime } from '../testing/fake-time.js';
import { flushNotifications, MemoryNotifyNetwork } from '../testing/memory-notify-bus.js';
import { LocalHub } from './local-hub.js';
import { PgNotifyHub } from './pg-notify-hub.js';
import { RelayRouter } from './relay-router.js';

/*
 * A deploy overlaps two relay processes (02 F1, RV-RLY-01): Railway starts the new one
 * while the old one still holds its sockets, then drains the old one. A phone that
 * reconnects lands on the new process while its agent stays on the old one.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const PHONE = '33333333-3333-4333-8333-333333333333';
const agentIdentity: DeviceIdentity = { userId: USER, deviceId: AGENT, kind: 'agent' };
const phoneIdentity: DeviceIdentity = { userId: USER, deviceId: PHONE, kind: 'phone' };

class FakeSocket implements PeerSocket {
  bufferedAmount = 0;
  readonly sent: Record<string, unknown>[] = [];
  readonly close = vi.fn<(code: number, reason: string) => void>();
  readonly terminate = vi.fn();
  readonly ping = vi.fn();
  send(text: string): void {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }
}

const hello = (kind: 'agent' | 'phone') =>
  JSON.stringify({
    v: 1,
    kind: 'hello',
    protocol: { min: 1, max: 1 },
    client: { kind, version: '0.0.0' },
  });

const request = {
  v: 1,
  kind: 'data',
  id: '01900000-0000-7000-8000-000000000001',
  from: AGENT,
  to: PHONE,
  session: null,
  cls: 'request',
  seq: 0,
  ts: 0,
  expiresAt: null,
  payload: 'AAAA',
};

interface Process {
  readonly router: RelayRouter;
  readonly undelivered: PendingRequestSink['undelivered'];
}

function relayProcess(time: FakeTime, hub: HubPort): Process {
  const directory = {
    authenticateAgent: vi.fn<DeviceDirectory['authenticateAgent']>(),
    phoneForSession: vi.fn<DeviceDirectory['phoneForSession']>(),
    listDevices: vi.fn<DeviceDirectory['listDevices']>(() => Promise.resolve([])),
    ownerOf: vi.fn<DeviceDirectory['ownerOf']>(() => Promise.resolve(USER)),
    markSeen: vi.fn<DeviceDirectory['markSeen']>(() => Promise.resolve()),
  };
  const undelivered = vi.fn<PendingRequestSink['undelivered']>();
  const router = new RelayRouter({
    clock: time.clock,
    timer: time.timer,
    hub,
    directory,
    pending: { undelivered, unacked: vi.fn<PendingRequestSink['unacked']>() },
    logger: createLogger({ level: 'info', destination: createMemoryDestination() }),
  });
  return { router, undelivered };
}

/** Old process A holds both devices; new process B starts and the phone moves to it. */
async function deploy(
  time: FakeTime,
  hubs: { a: HubPort; b: HubPort },
): Promise<{ a: Process; b: Process; agent: (text: string) => void; phoneSocket: FakeSocket }> {
  const a = relayProcess(time, hubs.a);
  const agent = a.router.accept(agentIdentity, new FakeSocket());
  agent.message(hello('agent'));
  const oldPhone = a.router.accept(phoneIdentity, new FakeSocket());
  oldPhone.message(hello('phone'));
  await flushNotifications();

  const b = relayProcess(time, hubs.b);
  await flushNotifications();
  oldPhone.closed();
  const phoneSocket = new FakeSocket();
  b.router.accept(phoneIdentity, phoneSocket).message(hello('phone'));
  await flushNotifications();
  await flushNotifications();
  return { a, b, agent: (text) => agent.message(text), phoneSocket };
}

function pgHub(time: FakeTime, network: MemoryNotifyNetwork): PgNotifyHub {
  return new PgNotifyHub({
    clock: time.clock,
    timer: time.timer,
    random: webCryptoRandom,
    bus: network.bus(),
    logger: createLogger({ level: 'info', destination: createMemoryDestination() }),
    deviceCap: 10,
  });
}

describe('deploy overlap (RV-RLY-01)', () => {
  it('phone on process A, agent on process B: request routed, no undelivered push', async () => {
    const time = createFakeTime();
    const network = new MemoryNotifyNetwork();
    const hubs = { a: pgHub(time, network), b: pgHub(time, network) };
    await hubs.a.start();
    await hubs.b.start();
    const { a, b, agent, phoneSocket } = await deploy(time, hubs);

    // The agent, still on the old process, asks for a decision.
    agent(JSON.stringify(request));
    await flushNotifications();
    await flushNotifications();

    expect(phoneSocket.sent).toContainEqual(request);
    expect(a.undelivered).not.toHaveBeenCalled();
    expect(b.undelivered).not.toHaveBeenCalled();
    await hubs.a.stop();
    await hubs.b.stop();
  });

  it('with a local hub per process the same request is undelivered (the F1 failure)', async () => {
    const time = createFakeTime();
    const { a, agent, phoneSocket } = await deploy(time, {
      a: new LocalHub(time.clock, 10),
      b: new LocalHub(time.clock, 10),
    });
    agent(JSON.stringify(request));
    await flushNotifications();
    await flushNotifications();

    expect(phoneSocket.sent).not.toContainEqual(request);
    expect(a.undelivered).toHaveBeenCalledWith(
      expect.objectContaining({ envelopeId: request.id, to: PHONE, cls: 'request' }),
    );
  });
});
