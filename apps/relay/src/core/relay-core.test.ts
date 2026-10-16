import { Envelope, MAX_PAYLOAD_LENGTH } from '@remote-control/protocol';
import { createLogger, createMemoryDestination, type MemoryDestination } from '@remote-control/log';
import { describe, expect, it, vi, type Mock } from 'vitest';

import type { DeviceDirectory, DeviceIdentity, DeviceRecord } from '../ports/device-directory.js';
import type { HubConnection } from '../ports/hub.js';
import type { PeerSocket } from '../ports/peer-socket.js';
import type { AuditSink, CommandGate } from '../ports/relay-seams.js';
import { createFakeTime, type FakeTime } from '../testing/fake-time.js';
import {
  ACK_WINDOW_MS,
  AckTracker,
  MAX_TRACKED_PER_RECIPIENT,
  UNACKED_REQUEST_MS,
  type TrackedDelivery,
} from './ack-tracker.js';
import { CLOSE_GRACE_MS, DEVICE_CAP, MAX_FRAME_BYTES } from './hub-limits.js';
import { LocalHub } from './local-hub.js';
import { RelayRouter, type SocketEvents } from './relay-router.js';
import { TokenBucket } from './token-bucket.js';

const USER = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const PHONE = '33333333-3333-4333-8333-333333333333';
const envelopeId = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

describe('TokenBucket', () => {
  it('allows a burst up to capacity and refills over time', () => {
    const time = createFakeTime();
    const bucket = new TokenBucket(time.clock, { capacity: 3, perSecond: 2 });
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    time.advance(499);
    expect(bucket.take()).toBe(false);
    time.advance(1);
    expect(bucket.take()).toBe(true);
    time.advance(60_000);
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });
});

function delivery(n: number, extra: Partial<TrackedDelivery> = {}): TrackedDelivery {
  return {
    envelopeId: envelopeId(n),
    userId: USER,
    from: AGENT,
    to: PHONE,
    watch: false,
    expiresAt: null,
    ...extra,
  };
}

describe('AckTracker', () => {
  it('groups acked ids by sender and ignores ids the recipient was never sent', () => {
    const time = createFakeTime();
    const tracker = new AckTracker(time.timer, vi.fn());
    tracker.track(delivery(1));
    tracker.track(delivery(2, { from: 'other' }));
    tracker.track(delivery(3));
    expect(tracker.ack('someone-else', [envelopeId(1)])).toEqual(new Map());
    expect(
      tracker.ack(PHONE, [envelopeId(1), envelopeId(2), envelopeId(3), envelopeId(9)]),
    ).toEqual(
      new Map([
        [AGENT, [envelopeId(1), envelopeId(3)]],
        ['other', [envelopeId(2)]],
      ]),
    );
    expect(tracker.size).toBe(0);
    expect(time.pending).toBe(0);
  });

  it('reports a watched delivery unacked after 3 s and forgets it after the ack window', () => {
    const time = createFakeTime();
    const onUnacked = vi.fn();
    const tracker = new AckTracker(time.timer, onUnacked);
    tracker.track(delivery(1, { watch: true }));
    tracker.track(delivery(2));
    time.advance(UNACKED_REQUEST_MS);
    expect(onUnacked).toHaveBeenCalledExactlyOnceWith(delivery(1, { watch: true }));
    expect(tracker.size).toBe(2);
    time.advance(ACK_WINDOW_MS - UNACKED_REQUEST_MS);
    expect(tracker.size).toBe(0);
    expect(time.pending).toBe(0);
  });

  it('replaces a re-sent id and drops the oldest beyond the per-recipient cap', () => {
    const time = createFakeTime();
    const tracker = new AckTracker(time.timer, vi.fn());
    tracker.track(delivery(1, { from: 'first' }));
    tracker.track(delivery(1, { from: 'second' }));
    expect(tracker.size).toBe(1);
    for (let n = 2; n <= MAX_TRACKED_PER_RECIPIENT + 1; n += 1) tracker.track(delivery(n));
    expect(tracker.size).toBe(MAX_TRACKED_PER_RECIPIENT);
    expect(tracker.ack(PHONE, [envelopeId(1)])).toEqual(new Map());
    // A forget timer of a replaced entry does not remove its successor.
    tracker.track(delivery(5000));
    time.advance(ACK_WINDOW_MS);
    expect(tracker.size).toBe(0);
    tracker.track(delivery(7));
    tracker.clear();
    expect(tracker.size).toBe(0);
    expect(time.pending).toBe(0);
  });
});

interface FakeConnection {
  readonly identity: DeviceIdentity;
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

describe('LocalHub', () => {
  it('tracks live devices per user, supersedes a device and enforces the cap', () => {
    const time = createFakeTime();
    const hub = new LocalHub(time.clock, 2);
    const agent = connection({ userId: USER, deviceId: AGENT, kind: 'agent' });
    const phone = connection({ userId: USER, deviceId: PHONE, kind: 'phone' });
    expect(hub.attach(agent)).toEqual({ ok: true, superseded: undefined });
    time.advance(10);
    expect(hub.attach(phone)).toEqual({ ok: true, superseded: undefined });
    expect(hub.presenceChangedAt(PHONE)).toBe(time.clock.now());
    expect(hub.attach(connection({ userId: USER, deviceId: 'third', kind: 'agent' }))).toEqual({
      ok: false,
      reason: 'device_cap',
    });
    const again = connection({ userId: USER, deviceId: AGENT, kind: 'agent' });
    expect(hub.attach(again)).toEqual({ ok: true, superseded: agent });
    expect(hub.detach(agent)).toBe(false);
    expect(hub.connection(USER, AGENT)).toBe(again);
    expect(hub.connections(USER)).toEqual([again, phone]);
    expect(hub.connections('nobody')).toEqual([]);
    expect(hub.count(USER)).toBe(2);
    expect([hub.online('agent'), hub.online('phone')]).toEqual([1, 1]);
    expect(hub.detach(phone)).toBe(true);
    expect(hub.online('phone')).toBe(0);
    expect(hub.detach(again)).toBe(true);
    expect(hub.count(USER)).toBe(0);
    expect(hub.detach(again)).toBe(false);
  });

  it('closes every connection at once', () => {
    const hub = new LocalHub(createFakeTime().clock, DEVICE_CAP);
    const a = connection({ userId: USER, deviceId: AGENT, kind: 'agent' });
    const b = connection({ userId: 'u2', deviceId: PHONE, kind: 'phone' });
    hub.attach(a);
    hub.attach(b);
    expect(hub.closeAll(1012, 'service restart')).toEqual([a, b]);
    expect(a.close).toHaveBeenCalledWith(1012, 'service restart');
    expect(b.close).toHaveBeenCalledWith(1012, 'service restart');
    expect(hub.count(USER)).toBe(0);
  });

  it('bounds the presence change log', () => {
    const hub = new LocalHub(createFakeTime().clock, DEVICE_CAP, 100);
    for (let n = 0; n <= 100; n += 1) {
      const conn = connection({ userId: USER, deviceId: `d${n}`, kind: 'agent' });
      hub.attach(conn);
      hub.detach(conn);
    }
    expect(hub.presenceChangedAt('d0')).toBeUndefined();
    expect(hub.presenceChangedAt('d1')).toBeDefined();
    expect(hub.presenceChangedAt('d100')).toBeDefined();
  });
});

describe('createFakeTime', () => {
  it('fires due callbacks in deadline order and skips cancelled ones', () => {
    const time = createFakeTime(1_000);
    const fired: string[] = [];
    time.timer.after(20, () => fired.push('b'));
    time.timer.after(10, () => {
      fired.push('a');
      time.timer.after(5, () => fired.push('a2'));
    });
    time.timer.after(20, () => fired.push('c'));
    time.timer.after(-5, () => fired.push('now'));
    time.timer.after(30, () => fired.push('never')).cancel();
    time.advance(25);
    expect(fired).toEqual(['now', 'a', 'a2', 'b', 'c']);
    expect(time.clock.now()).toBe(1_025);
    expect(time.pending).toBe(0);
  });
});

// ── RelayRouter edge cases (the happy paths run over real sockets in ws-route.test.ts) ──

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

interface Harness {
  readonly time: FakeTime;
  readonly router: RelayRouter;
  readonly hub: LocalHub;
  readonly directory: { readonly [K in keyof DeviceDirectory]: Mock<DeviceDirectory[K]> };
  readonly logs: MemoryDestination;
  readonly audit: { readonly decisionForwarded: Mock<AuditSink['decisionForwarded']> };
  connect(identity: DeviceIdentity): { socket: FakeSocket; events: SocketEvents };
}

const agentIdentity: DeviceIdentity = { userId: USER, deviceId: AGENT, kind: 'agent' };
const phoneIdentity: DeviceIdentity = { userId: USER, deviceId: PHONE, kind: 'phone' };

function harness(commandGate?: CommandGate): Harness {
  const time = createFakeTime();
  const logs = createMemoryDestination();
  const hub = new LocalHub(time.clock, DEVICE_CAP);
  const records: DeviceRecord[] = [];
  const directory: Harness['directory'] = {
    authenticateAgent: vi.fn<DeviceDirectory['authenticateAgent']>(),
    phoneForSession: vi.fn<DeviceDirectory['phoneForSession']>(),
    listDevices: vi.fn<DeviceDirectory['listDevices']>(() => Promise.resolve(records)),
    ownerOf: vi.fn<DeviceDirectory['ownerOf']>(() => Promise.resolve(USER)),
    markSeen: vi.fn<DeviceDirectory['markSeen']>(() => Promise.resolve()),
  };
  const audit = {
    decisionForwarded: vi.fn<AuditSink['decisionForwarded']>(),
    pushSent: vi.fn<AuditSink['pushSent']>(),
  };
  const router = new RelayRouter({
    clock: time.clock,
    timer: time.timer,
    hub,
    directory,
    audit,
    logger: createLogger({ level: 'info', destination: logs }),
    ...(commandGate === undefined ? {} : { commandGate }),
  });
  return {
    time,
    router,
    hub,
    directory,
    logs,
    audit,
    connect(identity) {
      const socket = new FakeSocket();
      return { socket, events: router.accept(identity, socket) };
    },
  };
}

const hello = (kind: 'agent' | 'phone') =>
  JSON.stringify({
    v: 1,
    kind: 'hello',
    protocol: { min: 1, max: 1 },
    client: { kind, version: '0.0.0' },
  });

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A phone → agent data frame of class `cls`. */
const data = (cls: 'command' | 'event', n: number, decisionHash?: string) =>
  JSON.stringify({
    v: 1,
    kind: 'data',
    id: envelopeId(n),
    from: PHONE,
    to: AGENT,
    session: null,
    cls,
    seq: n,
    ts: 0,
    expiresAt: null,
    payload: 'AAAA',
    ...(decisionHash === undefined ? {} : { decisionHash }),
  });
const command = (n: number, decisionHash?: string) => data('command', n, decisionHash);
const event = (n: number) => data('event', n);

describe('RelayRouter', () => {
  it('closes with 1012 when the presence snapshot fails', async () => {
    const h = harness();
    h.directory.listDevices.mockRejectedValueOnce(new Error('db down'));
    const { socket, events } = h.connect(agentIdentity);
    events.message(hello('agent'));
    await flush();
    expect(socket.close).toHaveBeenCalledWith(1012, 'try again');
    expect(h.logs.lines().join('\n')).toContain('"event":"presence_failed"');
    h.time.advance(CLOSE_GRACE_MS);
    expect(socket.terminate).toHaveBeenCalled();
    events.closed();
    expect(h.router.openSockets).toBe(0);
  });

  it('logs a failed last_seen_at write and a failed route without throwing', async () => {
    const h = harness();
    h.directory.markSeen.mockRejectedValue(new Error('db down'));
    h.directory.ownerOf.mockRejectedValueOnce(new Error('db down'));
    const { socket, events } = h.connect(agentIdentity);
    events.message(hello('agent'));
    await flush();
    expect(socket.sent[0]).toMatchObject({ kind: 'hello_ok' });
    events.message(
      JSON.stringify({
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
      }),
    );
    await flush();
    const logs = h.logs.lines().join('\n');
    expect(logs).toContain('"event":"last_seen_failed"');
    expect(logs).toContain('"event":"route_failed"');
    expect(logs).not.toContain('AAAA');
  });

  it('closes a socket that sends too many frames before hello_ok', async () => {
    const h = harness();
    let release: (records: DeviceRecord[]) => void = () => undefined;
    h.directory.listDevices.mockReturnValueOnce(
      new Promise<DeviceRecord[]>((resolve) => (release = resolve)),
    );
    const { socket, events } = h.connect(agentIdentity);
    events.message(hello('agent'));
    for (let n = 0; n <= 100; n += 1) {
      h.time.advance(10);
      events.message('{}');
    }
    expect(socket.close).toHaveBeenCalledWith(1008, 'too early');
    events.message('{}');
    release([]);
    await flush();
    // Closed while joining: never attached, never announced.
    expect(h.hub.count(USER)).toBe(0);
    events.closed();
    expect(h.directory.markSeen).not.toHaveBeenCalled();
  });

  it('refuses to attach past the device cap at hello', async () => {
    const h = harness();
    for (let n = 0; n < DEVICE_CAP; n += 1) {
      h.hub.attach(connection({ userId: USER, deviceId: `d${n}`, kind: 'agent' }));
    }
    const { socket, events } = h.connect(agentIdentity);
    events.message(hello('agent'));
    await flush();
    expect(socket.close).toHaveBeenCalledWith(1008, 'device cap');
  });

  it('stops sending to a socket with more than 1 MiB queued', async () => {
    const h = harness();
    const agent = h.connect(agentIdentity);
    const phone = h.connect(phoneIdentity);
    agent.events.message(hello('agent'));
    phone.events.message(hello('phone'));
    await flush();
    phone.socket.bufferedAmount = 2 * 1024 * 1024;
    const conn = h.hub.connection(USER, PHONE);
    expect(conn?.send('{}')).toBe(false);
    phone.socket.bufferedAmount = 0;
    expect(conn?.send('{}')).toBe(true);
  });

  it('audits a delivered command with a decision hash, not a dropped one or one without (M1-13)', async () => {
    const h = harness();
    const agent = h.connect(agentIdentity);
    const phone = h.connect(phoneIdentity);
    agent.events.message(hello('agent'));
    phone.events.message(hello('phone'));
    await flush();
    const hash = 'ab'.repeat(32);
    phone.events.message(command(1, hash));
    phone.events.message(command(2));
    await flush();
    agent.socket.bufferedAmount = 2 * 1024 * 1024;
    phone.events.message(command(3, hash));
    await flush();
    expect(h.audit.decisionForwarded.mock.calls).toEqual([[phoneIdentity, hash]]);
    expect(h.router.stats.backpressureDrops).toBe(1);
  });

  it("keeps a sender's frame order when the gate answers asynchronously (ADR 0016)", async () => {
    const h = harness({
      admit: (envelope) => Promise.resolve(envelope.decisionHash !== undefined),
    });
    const agent = h.connect(agentIdentity);
    const phone = h.connect(phoneIdentity);
    agent.events.message(hello('agent'));
    phone.events.message(hello('phone'));
    await flush();
    const before = agent.socket.sent.length;
    phone.events.message(command(1, 'ab'.repeat(32)));
    phone.events.message(event(2));
    await flush();
    expect(agent.socket.sent.slice(before).map((frame) => frame.id)).toEqual([
      envelopeId(1),
      envelopeId(2),
    ]);
  });

  it('answers unverified when the gate fails, and keeps routing', async () => {
    const h = harness({ admit: () => Promise.reject(new Error('db down')) });
    const agent = h.connect(agentIdentity);
    const phone = h.connect(phoneIdentity);
    agent.events.message(hello('agent'));
    phone.events.message(hello('phone'));
    await flush();
    const before = agent.socket.sent.length;
    phone.events.message(command(1, 'ab'.repeat(32)));
    phone.events.message(event(2));
    await flush();
    expect(phone.socket.sent).toContainEqual(
      expect.objectContaining({ kind: 'error', code: 'unverified', ref: envelopeId(1) }),
    );
    expect(agent.socket.sent.slice(before).map((frame) => frame.id)).toEqual([envelopeId(2)]);
    expect(h.logs.lines().join('\n')).toContain('"event":"gate_failed"');
  });

  it('drains: 1012 everywhere, no presence broadcast, last_seen_at stamped', async () => {
    const h = harness();
    const agent = h.connect(agentIdentity);
    const phone = h.connect(phoneIdentity);
    const late = h.connect({ userId: USER, deviceId: 'late', kind: 'agent' });
    agent.events.message(hello('agent'));
    phone.events.message(hello('phone'));
    await flush();
    h.directory.markSeen.mockClear();
    expect(await h.router.drain()).toBe(3);
    expect(h.router.draining).toBe(true);
    for (const peer of [agent, phone, late]) {
      expect(peer.socket.close).toHaveBeenCalledWith(1012, 'service restart');
    }
    const sentBefore = agent.socket.sent.length;
    phone.events.closed();
    agent.events.closed();
    late.events.closed();
    expect(agent.socket.sent).toHaveLength(sentBefore);
    expect(h.directory.markSeen.mock.calls.map(([id]) => id).sort()).toEqual([AGENT, PHONE].sort());
    expect(h.router.openSockets).toBe(0);
    // Frames after close are ignored.
    agent.events.message('{}');
    expect(agent.socket.sent).toHaveLength(sentBefore);
  });
});

describe('frame cap', () => {
  it('fits a data envelope with the largest payload under MAX_FRAME_BYTES (D3, D15)', () => {
    const frame = {
      v: 1,
      kind: 'data',
      id: envelopeId(1),
      from: AGENT,
      to: PHONE,
      session: null,
      cls: 'event',
      seq: Number.MAX_SAFE_INTEGER,
      ts: Number.MAX_SAFE_INTEGER,
      expiresAt: Number.MAX_SAFE_INTEGER,
      payload: 'A'.repeat(MAX_PAYLOAD_LENGTH),
    };
    expect(Envelope.safeParse(frame).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(frame)).length).toBeLessThan(MAX_FRAME_BYTES);
  });
});
