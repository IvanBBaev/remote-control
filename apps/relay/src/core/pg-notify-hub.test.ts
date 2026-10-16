import { webCryptoRandom } from '@remote-control/crypto';
import { createLogger, createMemoryDestination, type MemoryDestination } from '@remote-control/log';
import { describe, expect, it, vi, type Mock } from 'vitest';

import type { DeviceDirectory, DeviceIdentity, DeviceRecord } from '../ports/device-directory.js';
import type { ClusterHandlers, HubConnection } from '../ports/hub.js';
import type { NotifyBus } from '../ports/notify-bus.js';
import type { PeerSocket } from '../ports/peer-socket.js';
import type { AuditSink } from '../ports/relay-seams.js';
import { createFakeTime, type FakeTime } from '../testing/fake-time.js';
import { flushNotifications, MemoryNotifyNetwork } from '../testing/memory-notify-bus.js';
import {
  HUB_CHANNEL,
  HUB_HEARTBEAT_MS,
  HUB_REPLICA_TIMEOUT_MS,
  MAX_NOTIFY_BYTES,
  PgNotifyHub,
} from './pg-notify-hub.js';
import { RelayRouter } from './relay-router.js';

const USER = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const PHONE = '33333333-3333-4333-8333-333333333333';
const envelopeId = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const agentIdentity: DeviceIdentity = { userId: USER, deviceId: AGENT, kind: 'agent' };
const phoneIdentity: DeviceIdentity = { userId: USER, deviceId: PHONE, kind: 'phone' };

interface FakeConnection extends HubConnection {
  readonly send: Mock<HubConnection['send']>;
  readonly close: Mock<HubConnection['close']>;
}

function connection(identity: DeviceIdentity): FakeConnection {
  return {
    identity,
    send: vi.fn<HubConnection['send']>(() => true),
    close: vi.fn<HubConnection['close']>(),
  };
}

interface Cluster {
  readonly time: FakeTime;
  readonly network: MemoryNotifyNetwork;
  readonly logs: MemoryDestination;
  hub(options?: { deviceCap?: number }): { hub: PgNotifyHub; bus: NotifyBus };
}

function cluster(): Cluster {
  const time = createFakeTime();
  const network = new MemoryNotifyNetwork();
  const logs = createMemoryDestination();
  return {
    time,
    network,
    logs,
    hub(options = {}) {
      const bus = network.bus();
      const hub = new PgNotifyHub({
        clock: time.clock,
        timer: time.timer,
        random: webCryptoRandom,
        bus,
        logger: createLogger({ level: 'info', destination: logs }),
        deviceCap: options.deviceCap ?? 10,
      });
      return { hub, bus };
    },
  };
}

async function started(c: Cluster, count: number): Promise<PgNotifyHub[]> {
  const hubs = Array.from({ length: count }, () => c.hub().hub);
  for (const hub of hubs) await hub.start();
  await flushNotifications();
  return hubs;
}

function handlers(hub: PgNotifyHub): {
  ack: Mock<ClusterHandlers['ack']>;
  lost: Mock<ClusterHandlers['lost']>;
} {
  const bound = { ack: vi.fn<ClusterHandlers['ack']>(), lost: vi.fn<ClusterHandlers['lost']>() };
  hub.bind(bound);
  return bound;
}

describe('PgNotifyHub', () => {
  it('shows a device attached on one replica on the other and forgets it on detach', async () => {
    const c = cluster();
    const [a, b] = await started(c, 2);
    expect(a?.peers).toEqual([b?.replicaId]);
    const agent = connection(agentIdentity);
    expect(a?.attach(agent)).toEqual({ ok: true, superseded: undefined });
    await flushNotifications();
    expect(b?.connection(USER, AGENT)?.identity).toEqual(agentIdentity);
    expect(b?.connections(USER)).toHaveLength(1);
    expect([b?.count(USER), b?.online('agent'), b?.online('phone')]).toEqual([1, 1, 0]);
    expect(b?.presenceChangedAt(AGENT)).toBe(c.time.clock.now());
    c.time.advance(10);
    expect(a?.detach(agent)).toBe(true);
    expect(a?.detach(agent)).toBe(false);
    await flushNotifications();
    expect(b?.connection(USER, AGENT)).toBeUndefined();
    expect(b?.count(USER)).toBe(0);
    expect(b?.presenceChangedAt(AGENT)).toBe(c.time.clock.now());
    expect(b?.presenceChangedAt('nobody')).toBeUndefined();
  });

  it('delivers a proxy send to the owning replica, chunking a large frame', async () => {
    const c = cluster();
    const [a, b] = await started(c, 2);
    const phone = connection(phoneIdentity);
    a?.attach(phone);
    await flushNotifications();
    const proxy = b?.connection(USER, PHONE);
    expect(proxy?.send('{"small":true}')).toBe(true);
    // Multi-byte characters: the chunking must count bytes, not string length.
    const large = JSON.stringify({ payload: 'ж€😀'.repeat(6_000) });
    expect(proxy?.send(large)).toBe(true);
    await flushNotifications();
    expect(phone.send.mock.calls).toEqual([['{"small":true}'], [large]]);
    const direct = c.network.published.filter(
      (n) => n.channel === `${HUB_CHANNEL}_${a?.replicaId}`,
    );
    expect(direct.length).toBeGreaterThan(3);
    for (const { payload } of c.network.published) {
      expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(MAX_NOTIFY_BYTES);
    }
  });

  it('closes the device on its own replica when a proxy is closed', async () => {
    const c = cluster();
    const [a, b] = await started(c, 2);
    const phone = connection(phoneIdentity);
    a?.attach(phone);
    await flushNotifications();
    b?.connection(USER, PHONE)?.close(4001, 'revoked');
    await flushNotifications();
    expect(phone.close).toHaveBeenCalledExactlyOnceWith(4001, 'revoked');
  });

  it('moves a device between replicas without reporting it offline', async () => {
    const c = cluster();
    const [a, b] = await started(c, 2);
    const first = connection(agentIdentity);
    a?.attach(first);
    await flushNotifications();
    const second = connection(agentIdentity);
    const result = b?.attach(second);
    expect(result).toMatchObject({ ok: true });
    // The session closes the superseded proxy with 4000; that reaches the old socket.
    if (result?.ok === true) result.superseded?.close(4000, 'superseded');
    await flushNotifications();
    expect(first.close).toHaveBeenCalledExactlyOnceWith(4000, 'superseded');
    // The old socket's close then detaches it — already forgotten, so no offline.
    expect(a?.detach(first)).toBe(false);
    await flushNotifications();
    expect(a?.connection(USER, AGENT)?.identity).toEqual(agentIdentity);
    expect(b?.connection(USER, AGENT)).toBe(second);
    expect([a?.count(USER), b?.count(USER)]).toEqual([1, 1]);
  });

  it('supersedes a local connection of the same device as LocalHub does', async () => {
    const c = cluster();
    const [a] = await started(c, 1);
    const first = connection(agentIdentity);
    a?.attach(first);
    const second = connection(agentIdentity);
    expect(a?.attach(second)).toEqual({ ok: true, superseded: first });
    expect(a?.detach(first)).toBe(false);
    expect(a?.closeAll(1012, 'restart')).toEqual([second]);
    expect(second.close).toHaveBeenCalledWith(1012, 'restart');
  });

  it('enforces the device cap across replicas', async () => {
    const c = cluster();
    const a = c.hub({ deviceCap: 2 }).hub;
    const b = c.hub({ deviceCap: 2 }).hub;
    await a.start();
    await b.start();
    await flushNotifications();
    a.attach(connection(agentIdentity));
    b.attach(connection(phoneIdentity));
    await flushNotifications();
    const third = connection({ userId: USER, deviceId: 'third', kind: 'agent' });
    expect(a.attach(third)).toEqual({ ok: false, reason: 'device_cap' });
    // A device already counted may always reconnect.
    expect(a.attach(connection(phoneIdentity))).toMatchObject({ ok: true });
  });

  it('tells a replica that starts late about the devices already connected', async () => {
    const c = cluster();
    const [a] = await started(c, 1);
    a?.attach(connection(agentIdentity));
    await flushNotifications();
    const [late] = await started(c, 1);
    await flushNotifications();
    expect(late?.connection(USER, AGENT)?.identity).toEqual(agentIdentity);
    expect(late?.peers).toEqual([a?.replicaId]);
  });

  it('drops the devices of a replica that says goodbye without reporting them lost', async () => {
    const c = cluster();
    const [a, b] = await started(c, 2);
    const lost = handlers(b!).lost;
    a?.attach(connection(agentIdentity));
    await flushNotifications();
    await a?.stop();
    await a?.stop();
    await flushNotifications();
    expect(b?.connection(USER, AGENT)).toBeUndefined();
    expect(b?.peers).toEqual([]);
    expect(lost).not.toHaveBeenCalled();
    expect(a?.connection(USER, AGENT)?.send('x')).toBe(true);
  });

  it('reports the devices of a silent replica lost to local peers after the timeout', async () => {
    const c = cluster();
    const { hub: a, bus: busA } = c.hub();
    const { hub: b } = c.hub();
    await a.start();
    await b.start();
    await flushNotifications();
    const lost = handlers(b).lost;
    a.attach(connection(agentIdentity));
    const phone = connection(phoneIdentity);
    b.attach(phone);
    await flushNotifications();
    c.network.partition(busA, true);
    for (let at = 0; at < HUB_REPLICA_TIMEOUT_MS; at += HUB_HEARTBEAT_MS) {
      c.time.advance(HUB_HEARTBEAT_MS);
      await flushNotifications();
    }
    c.time.advance(HUB_HEARTBEAT_MS);
    await flushNotifications();
    expect(lost).toHaveBeenCalledExactlyOnceWith(agentIdentity, [phone]);
    expect(b.connection(USER, AGENT)).toBeUndefined();
    expect(c.logs.lines().join('\n')).toContain('"event":"hub_replica_lost"');
    expect(c.logs.lines().join('\n')).toContain('"event":"hub_publish_failed"');
    // A proxy of a stopped hub refuses to send.
    const proxy = a.connection(USER, PHONE);
    await a.stop();
    expect(proxy?.send('x')).toBe(false);
  });

  it('fans out acks to every replica in batches', async () => {
    const c = cluster();
    const [a, b] = await started(c, 2);
    const ack = handlers(b!).ack;
    const ownAck = handlers(a!).ack;
    const ids = Array.from({ length: 130 }, (_, n) => envelopeId(n));
    a?.publishAck(USER, PHONE, ids);
    await flushNotifications();
    expect(ack.mock.calls).toEqual([
      [USER, PHONE, ids.slice(0, 128)],
      [USER, PHONE, ids.slice(128)],
    ]);
    expect(ownAck).not.toHaveBeenCalled();
  });

  it('logs and ignores a malformed notification', async () => {
    const c = cluster();
    await started(c, 1);
    await c.network.bus().publish([{ channel: HUB_CHANNEL, payload: '{"t":"nope"}' }]);
    await c.network.bus().publish([{ channel: HUB_CHANNEL, payload: 'not json' }]);
    await flushNotifications();
    const lines = c.logs.lines().filter((line) => line.includes('"event":"hub_message_invalid"'));
    expect(lines).toHaveLength(2);
  });

  it('re-announces its devices after the listening connection comes back', async () => {
    const c = cluster();
    const [a, b] = await started(c, 2);
    a?.attach(connection(agentIdentity));
    await flushNotifications();
    // As if b missed everything while its LISTEN connection was down.
    b?.bind({ ack: vi.fn(), lost: vi.fn() });
    const before = c.network.published.length;
    c.network.reconnectAll();
    await flushNotifications();
    const resent = c.network.published
      .slice(before)
      .map((n) => JSON.parse(n.payload) as { t: string });
    expect(resent.map((m) => m.t)).toEqual(expect.arrayContaining(['hello', 'on']));
    expect(b?.connection(USER, AGENT)?.identity).toEqual(agentIdentity);
  });

  it('forgets the devices that left while its listening connection was down', async () => {
    const c = cluster();
    const { hub: a } = c.hub();
    const { hub: b, bus: busB } = c.hub();
    await a.start();
    await b.start();
    const agent = connection(agentIdentity);
    a.attach(agent);
    await flushNotifications();
    c.network.deafen(busB, true);
    a.detach(agent);
    await flushNotifications();
    expect(b.connection(USER, AGENT)).toBeDefined();
    c.network.deafen(busB, false);
    c.network.reconnect(busB);
    await flushNotifications();
    expect(b.connection(USER, AGENT)).toBeUndefined();
    expect(b.count(USER)).toBe(0);
  });

  it('keeps a device that moved while the old replica was not listening', async () => {
    const c = cluster();
    const { hub: a, bus: busA } = c.hub();
    const { hub: b } = c.hub();
    await a.start();
    await b.start();
    const first = connection(agentIdentity);
    a.attach(first);
    await flushNotifications();
    c.network.deafen(busA, true);
    c.time.advance(10);
    const second = connection(agentIdentity);
    const result = b.attach(second);
    if (result.ok) result.superseded?.close(4000, 'superseded');
    await flushNotifications();
    c.network.deafen(busA, false);
    c.network.reconnect(busA);
    await flushNotifications();
    await flushNotifications();
    expect(b.connection(USER, AGENT)).toBe(second);
    expect(a.connection(USER, AGENT)).not.toBe(first);
    expect(a.connection(USER, AGENT)?.identity).toEqual(agentIdentity);
    expect([a.count(USER), b.count(USER)]).toEqual([1, 1]);
  });

  it('settles two attaches of one device on the later one', async () => {
    const c = cluster();
    const [a, b] = await started(c, 2);
    const first = connection(agentIdentity);
    a?.attach(first);
    c.time.advance(1);
    const second = connection(agentIdentity);
    b?.attach(second);
    await flushNotifications();
    await flushNotifications();
    expect(b?.connection(USER, AGENT)).toBe(second);
    expect(a?.connection(USER, AGENT)).not.toBe(first);
    expect(a?.connection(USER, AGENT)?.identity).toEqual(agentIdentity);
  });

  it('re-announces its devices to a replica that took it for gone', async () => {
    const c = cluster();
    const { hub: a, bus: busA } = c.hub();
    const { hub: b, bus: busB } = c.hub();
    await a.start();
    await b.start();
    handlers(b);
    a.attach(connection(agentIdentity));
    await flushNotifications();
    const silence = async (cut: (on: boolean) => void) => {
      cut(true);
      for (let at = 0; at <= HUB_REPLICA_TIMEOUT_MS; at += HUB_HEARTBEAT_MS) {
        c.time.advance(HUB_HEARTBEAT_MS);
        await flushNotifications();
      }
      expect(b.connection(USER, AGENT)).toBeUndefined();
      cut(false);
      c.time.advance(HUB_HEARTBEAT_MS);
      await flushNotifications();
      await flushNotifications();
      expect(b.connection(USER, AGENT)?.identity).toEqual(agentIdentity);
    };
    // a's notifications are lost (failed publishes): it announces again once they work.
    await silence((on) => c.network.partition(busA, on));
    // b stops hearing a: it asks a again when a is heard from.
    await silence((on) => c.network.deafen(busB, on));
  });

  it('opens no notification once stopped', async () => {
    const c = cluster();
    const [a] = await started(c, 1);
    await a?.stop();
    const before = c.network.published.length;
    a?.publishAck(USER, PHONE, [envelopeId(1)]);
    expect(c.network.published).toHaveLength(before);
    expect(c.logs.lines().join('\n')).not.toContain('hub_publish_failed');
  });
});

// ── Two routers, one per replica ──────────────────────────────────────────────────

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

function replica(c: Cluster): { hub: PgNotifyHub; router: RelayRouter } {
  const { hub } = c.hub();
  const records: DeviceRecord[] = [];
  const directory = {
    authenticateAgent: vi.fn<DeviceDirectory['authenticateAgent']>(),
    phoneForSession: vi.fn<DeviceDirectory['phoneForSession']>(),
    listDevices: vi.fn<DeviceDirectory['listDevices']>(() => Promise.resolve(records)),
    ownerOf: vi.fn<DeviceDirectory['ownerOf']>(() => Promise.resolve(USER)),
    markSeen: vi.fn<DeviceDirectory['markSeen']>(() => Promise.resolve()),
  };
  const router = new RelayRouter({
    clock: c.time.clock,
    timer: c.time.timer,
    hub,
    directory,
    audit: {
      decisionForwarded: vi.fn<AuditSink['decisionForwarded']>(),
      pushSent: vi.fn<AuditSink['pushSent']>(),
    },
    logger: createLogger({ level: 'info', destination: c.logs }),
  });
  return { hub, router };
}

describe('RelayRouter over PgNotifyHub', () => {
  it('routes an envelope, its ack and presence between two replicas', async () => {
    const c = cluster();
    const a = replica(c);
    const b = replica(c);
    await a.hub.start();
    await b.hub.start();
    await flushNotifications();

    const phoneSocket = new FakeSocket();
    const phoneEvents = a.router.accept(phoneIdentity, phoneSocket);
    phoneEvents.message(hello('phone'));
    await flushNotifications();
    const agentSocket = new FakeSocket();
    const agentEvents = b.router.accept(agentIdentity, agentSocket);
    agentEvents.message(hello('agent'));
    await flushNotifications();
    await flushNotifications();
    expect(phoneSocket.sent).toContainEqual(
      expect.objectContaining({ kind: 'presence', deviceId: AGENT, online: true }),
    );

    const envelope = {
      v: 1,
      kind: 'data',
      id: envelopeId(1),
      from: AGENT,
      to: PHONE,
      session: null,
      cls: 'event',
      seq: 0,
      ts: 0,
      expiresAt: null,
      payload: 'AAAA',
    };
    agentEvents.message(JSON.stringify(envelope));
    await flushNotifications();
    await flushNotifications();
    expect(phoneSocket.sent).toContainEqual(envelope);

    phoneEvents.message(JSON.stringify({ v: 1, kind: 'ack', ids: [envelopeId(1)] }));
    await flushNotifications();
    expect(agentSocket.sent).toContainEqual({ v: 1, kind: 'ack', ids: [envelopeId(1)] });
    expect(b.router.trackedDeliveries).toBe(0);

    agentEvents.closed();
    await flushNotifications();
    expect(phoneSocket.sent).toContainEqual(
      expect.objectContaining({ kind: 'presence', deviceId: AGENT, online: false }),
    );
    const logs = c.logs.lines().join('\n');
    expect(logs).not.toContain('AAAA');
  });
});
