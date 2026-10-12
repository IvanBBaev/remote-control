import { EventEmitter } from 'node:events';

import { PGlite } from '@electric-sql/pglite';
import { sha256, utf8, webCryptoRandom } from '@remote-control/crypto';
import { createLogger, createMemoryDestination, type MemoryDestination } from '@remote-control/log';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDrizzleAccountStore } from '../adapters/drizzle-account-store.js';
import { createDrizzleDeviceDirectory } from '../adapters/drizzle-device-directory.js';
import { createPgliteDb } from '../adapters/pglite-db.js';
import { createScryptSecretHasher } from '../adapters/scrypt-secret-hasher.js';
import { createSimpleWebAuthn } from '../adapters/simple-webauthn.js';
import { buildApp } from '../app.js';
import { AccountService } from '../core/account-service.js';
import { DrainState } from '../core/drain-state.js';
import { DEVICE_CAP, MAX_FRAME_BYTES } from '../core/hub-limits.js';
import { LocalHub } from '../core/local-hub.js';
import { RelayRouter } from '../core/relay-router.js';
import { agentTokens, devices, sessions, users } from '../db/schema.js';
import { startServer } from '../main.js';
import { MIGRATIONS_DIR } from '../package-paths.js';
import type { Db } from '../ports/db.js';
import type { CommandGate, PendingRequestSink } from '../ports/relay-seams.js';
import { createFakeTime, type FakeTime } from '../testing/fake-time.js';
import { WsPeer } from '../testing/ws-peer.js';
import type { StateBody } from '../http/state-route.js';
import { rawText } from './ws-route.js';

const ORIGIN = 'https://rc.example.test';
const DAY = 24 * 60 * 60 * 1000;

const client = new PGlite();
let db: Db;

beforeAll(async () => {
  db = createPgliteDb(client, { migrationsFolder: MIGRATIONS_DIR });
  await db.migrate();
});

afterAll(() => client.close());

let counter = 0;
const unique = () => (counter += 1);

/** A UUIDv7-shaped envelope id. */
const envelopeId = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

interface Relay {
  readonly app: FastifyInstance;
  readonly url: string;
  readonly time: FakeTime;
  readonly router: RelayRouter;
  readonly hub: LocalHub;
  readonly drain: DrainState;
  readonly logs: MemoryDestination;
  readonly pending: { undelivered: ReturnType<typeof vi.fn>; unacked: ReturnType<typeof vi.fn> };
}

const running: Relay[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((relay) => relay.app.close()));
});

async function startRelay(options: { commandGate?: CommandGate } = {}): Promise<Relay> {
  const time = createFakeTime();
  const logs = createMemoryDestination();
  const logger = createLogger({ level: 'info', destination: logs });
  const directory = createDrizzleDeviceDirectory(db.orm);
  const hub = new LocalHub(time.clock, DEVICE_CAP);
  const pending = { undelivered: vi.fn(), unacked: vi.fn() } satisfies PendingRequestSink;
  const router = new RelayRouter({
    clock: time.clock,
    timer: time.timer,
    hub,
    directory,
    logger,
    pending,
    ...(options.commandGate === undefined ? {} : { commandGate: options.commandGate }),
  });
  const service = new AccountService({
    store: createDrizzleAccountStore(db.orm),
    webauthn: createSimpleWebAuthn({ id: 'rc.example.test', origin: ORIGIN, name: 'rc' }),
    hasher: createScryptSecretHasher(webCryptoRandom),
    clock: time.clock,
    random: webCryptoRandom,
  });
  const drain = new DrainState();
  const app = await buildApp({
    logger,
    clock: time.clock,
    database: db,
    drain,
    version: '0.0.0',
    commit: null,
    publicDir: undefined,
    auth: { service, origin: ORIGIN },
    relay: { router, hub, directory },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const relay: Relay = {
    app,
    url: `ws://127.0.0.1:${address.port}/ws`,
    time,
    router,
    hub,
    drain,
    logs,
    pending,
  };
  running.push(relay);
  return relay;
}

interface Phone {
  readonly deviceId: string;
  readonly headers: Record<string, string>;
}

interface Agent {
  readonly deviceId: string;
  readonly headers: Record<string, string>;
}

async function addUser(): Promise<string> {
  const [user] = await db.orm
    .insert(users)
    .values({ webauthnUserId: `user-${unique()}` })
    .returning({ id: users.id });
  return user!.id;
}

async function addPhone(userId: string, now: number, name = 'Pixel'): Promise<Phone> {
  const [device] = await db.orm
    .insert(devices)
    .values({ userId, kind: 'phone', name, createdAt: new Date(now) })
    .returning({ id: devices.id });
  const token = `phone${unique()}`.padEnd(43, 'x');
  await db.orm.insert(sessions).values({
    userId,
    deviceId: device!.id,
    tokenHash: await sha256(utf8(token)),
    lastSeenAt: new Date(now),
    expiresAt: new Date(now + 30 * DAY),
  });
  return {
    deviceId: device!.id,
    headers: {
      origin: ORIGIN,
      'sec-fetch-site': 'same-origin',
      cookie: `__Host-rc_session=${token}`,
    },
  };
}

async function addAgent(userId: string, now: number, name = 'mac'): Promise<Agent> {
  const [device] = await db.orm
    .insert(devices)
    .values({ userId, kind: 'agent', name, createdAt: new Date(now) })
    .returning({ id: devices.id });
  const token = `rc-agent-${unique()}`;
  await db.orm.insert(agentTokens).values({
    userId,
    agentDeviceId: device!.id,
    tokenHash: await sha256(utf8(token)),
  });
  return { deviceId: device!.id, headers: { authorization: `Bearer ${token}` } };
}

function envelope(
  from: string,
  to: string | null,
  n: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    v: 1,
    kind: 'data',
    id: envelopeId(n),
    from,
    to,
    session: null,
    cls: 'event',
    seq: n,
    ts: 0,
    expiresAt: null,
    payload: 'AAAA',
    ...extra,
  };
}

/** One user with an agent and a phone, both connected and past `hello`. */
async function pair(relay: Relay) {
  const userId = await addUser();
  const now = relay.time.clock.now();
  const agent = await addAgent(userId, now);
  const phone = await addPhone(userId, now);
  const agentPeer = await WsPeer.open(relay.url, agent.headers);
  await agentPeer.hello('agent');
  const phonePeer = await WsPeer.open(relay.url, phone.headers);
  await phonePeer.hello('phone');
  await agentPeer.next('presence');
  return { userId, agent, phone, agentPeer, phonePeer };
}

describe('GET /ws upgrade authentication (D15, D8)', () => {
  it('refuses missing, invalid and foreign credentials before accepting the socket', async () => {
    const relay = await startRelay();
    const userId = await addUser();
    const phone = await addPhone(userId, relay.time.clock.now());

    expect(await WsPeer.rejection(relay.url, {})).toBe(403);
    expect(await WsPeer.rejection(relay.url, { origin: ORIGIN })).toBe(401);
    expect(await WsPeer.rejection(relay.url, { authorization: 'Bearer nope' })).toBe(401);
    expect(await WsPeer.rejection(relay.url, { authorization: 'Basic abc' })).toBe(401);
    expect(await WsPeer.rejection(relay.url, { authorization: `Bearer ${'x'.repeat(513)}` })).toBe(
      401,
    );
    expect(
      await WsPeer.rejection(relay.url, { ...phone.headers, origin: 'https://evil.test' }),
    ).toBe(403);
    expect(
      await WsPeer.rejection(relay.url, { ...phone.headers, 'sec-fetch-site': 'cross-site' }),
    ).toBe(403);

    // A login session that is not bound to a phone device (pairing is M0-11).
    const [session] = await db.orm
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.deviceId, phone.deviceId));
    await db.orm.update(sessions).set({ deviceId: null }).where(eq(sessions.id, session!.id));
    expect(await WsPeer.rejection(relay.url, phone.headers)).toBe(401);

    // A revoked agent device.
    const agent = await addAgent(userId, relay.time.clock.now());
    await db.orm
      .update(devices)
      .set({ revokedAt: new Date(relay.time.clock.now()) })
      .where(eq(devices.id, agent.deviceId));
    expect(await WsPeer.rejection(relay.url, agent.headers)).toBe(401);

    const logs = relay.logs.lines().join('\n');
    expect(logs).toContain('"reason":"unauthenticated"');
    expect(logs).not.toContain('Bearer');
    expect(logs).not.toContain('rc_session=');
  });

  it('answers a plain GET without an upgrade with 404', async () => {
    const relay = await startRelay();
    expect((await relay.app.inject('/ws')).statusCode).toBe(404);
  });

  it('caps live devices per user at 10 (429)', async () => {
    const relay = await startRelay();
    const userId = await addUser();
    const now = relay.time.clock.now();
    const agents = await Promise.all(
      Array.from({ length: DEVICE_CAP + 1 }, (_, i) => addAgent(userId, now, `m${i}`)),
    );
    const peers: WsPeer[] = [];
    for (const agent of agents.slice(0, DEVICE_CAP)) {
      const peer = await WsPeer.open(relay.url, agent.headers);
      await peer.hello('agent');
      peers.push(peer);
    }
    expect(relay.hub.count(userId)).toBe(DEVICE_CAP);
    expect(await WsPeer.rejection(relay.url, agents[DEVICE_CAP]!.headers)).toBe(429);
    // A device that is already connected may still replace its own socket.
    const again = await WsPeer.open(relay.url, agents[0]!.headers);
    await again.hello('agent');
    expect(await peers[0]!.closed).toEqual({ code: 4000, reason: 'superseded' });
  });
});

describe('hello / presence (D14)', () => {
  it('answers hello with the negotiated version and a presence snapshot, then broadcasts presence', async () => {
    const relay = await startRelay();
    const userId = await addUser();
    const now = relay.time.clock.now();
    const agent = await addAgent(userId, now);
    const phone = await addPhone(userId, now, 'My phone');
    const revoked = await addPhone(userId, now);
    await db.orm
      .update(devices)
      .set({ revokedAt: new Date(now) })
      .where(eq(devices.id, revoked.deviceId));

    const agentPeer = await WsPeer.open(relay.url, agent.headers);
    const agentOk = await agentPeer.hello('agent');
    expect(agentOk).toEqual({
      v: 1,
      kind: 'hello_ok',
      protocol: 1,
      min_supported: 1,
      deviceId: agent.deviceId,
      relayTs: now,
      presence: [
        {
          deviceId: phone.deviceId,
          kind: 'phone',
          name: 'My phone',
          online: false,
          lastSeen: null,
        },
      ],
    });

    relay.time.advance(1_000);
    const phonePeer = await WsPeer.open(relay.url, phone.headers);
    const phoneOk = await phonePeer.hello('phone');
    expect(phoneOk.presence).toEqual([
      { deviceId: agent.deviceId, kind: 'agent', name: 'mac', online: true, lastSeen: now + 1_000 },
    ]);
    expect(await agentPeer.next('presence')).toEqual({
      v: 1,
      kind: 'presence',
      deviceId: phone.deviceId,
      online: true,
      at: now + 1_000,
    });

    relay.time.advance(1_000);
    phonePeer.close();
    expect(await agentPeer.next('presence')).toMatchObject({ online: false, at: now + 2_000 });
    const [row] = await db.orm
      .select({ lastSeenAt: devices.lastSeenAt })
      .from(devices)
      .where(eq(devices.id, phone.deviceId));
    expect(row?.lastSeenAt?.getTime()).toBe(now + 2_000);
  });

  it('closes a socket whose first frame is not a valid hello', async () => {
    const relay = await startRelay();
    const userId = await addUser();
    const agent = await addAgent(userId, relay.time.clock.now());

    const notHello = await WsPeer.open(relay.url, agent.headers);
    notHello.send({ v: 1, kind: 'ping', t: 1 });
    expect((await notHello.closed).code).toBe(1008);

    const wrongKind = await WsPeer.open(relay.url, agent.headers);
    await expect(Promise.race([wrongKind.hello('phone'), wrongKind.closed])).resolves.toEqual({
      code: 1008,
      reason: 'client kind mismatch',
    });

    const tooNew = await WsPeer.open(relay.url, agent.headers);
    tooNew.send({
      v: 1,
      kind: 'hello',
      protocol: { min: 2, max: 3 },
      client: { kind: 'agent', version: '9.0.0' },
    });
    expect(await tooNew.next('error')).toMatchObject({ code: 'unsupported_version' });
    expect((await tooNew.closed).code).toBe(4001);

    const futureFrame = await WsPeer.open(relay.url, agent.headers);
    futureFrame.send({ v: 2, kind: 'hello' });
    expect(await futureFrame.next('error')).toMatchObject({ code: 'unsupported_version' });
    expect((await futureFrame.closed).code).toBe(4001);

    const garbage = await WsPeer.open(relay.url, agent.headers);
    garbage.send('{not json');
    expect((await garbage.closed).code).toBe(1008);

    const binary = await WsPeer.open(relay.url, agent.headers);
    binary.socket.send(Buffer.from([1, 2, 3]));
    expect(await binary.closed).toEqual({ code: 1008, reason: 'binary frames are not accepted' });

    const silent = await WsPeer.open(relay.url, agent.headers);
    relay.time.advance(10_000);
    expect(await silent.closed).toEqual({ code: 1008, reason: 'hello timeout' });
  });

  it('closes on a second hello or a relay-only frame, and answers ping with pong', async () => {
    const relay = await startRelay();
    const { agentPeer, phonePeer } = await pair(relay);

    agentPeer.send({ v: 1, kind: 'ping', t: 42 });
    expect(await agentPeer.next('pong')).toEqual({
      v: 1,
      kind: 'pong',
      t: 42,
      relayTs: relay.time.clock.now(),
    });

    agentPeer.send({
      v: 1,
      kind: 'hello',
      protocol: { min: 1, max: 1 },
      client: { kind: 'agent', version: '0.0.0' },
    });
    expect(await agentPeer.closed).toEqual({ code: 1008, reason: 'unexpected frame' });

    phonePeer.send({ v: 1, kind: 'pong', t: 1, relayTs: 1 });
    expect((await phonePeer.closed).code).toBe(1008);
  });

  it('replays frames sent right behind hello once hello_ok is out', async () => {
    const relay = await startRelay();
    const userId = await addUser();
    const now = relay.time.clock.now();
    const agent = await addAgent(userId, now);
    const phone = await addPhone(userId, now);
    const phonePeer = await WsPeer.open(relay.url, phone.headers);
    await phonePeer.hello('phone');

    const agentPeer = await WsPeer.open(relay.url, agent.headers);
    agentPeer.send({
      v: 1,
      kind: 'hello',
      protocol: { min: 1, max: 1 },
      client: { kind: 'agent', version: '0.0.0' },
    });
    agentPeer.send(envelope(agent.deviceId, phone.deviceId, 1));
    await agentPeer.next('hello_ok');
    expect(await phonePeer.next('data')).toMatchObject({ id: envelopeId(1) });
  });
});

describe('routing (D14, D25, 03 §5.5)', () => {
  it('forwards envelopes inside the user and the recipient ack back to the sender (D4)', async () => {
    const relay = await startRelay();
    const { agent, phone, agentPeer, phonePeer } = await pair(relay);

    const frame = envelope(agent.deviceId, phone.deviceId, 1, {
      cls: 'reply',
      session: 's1',
      replyTo: envelopeId(99),
      payload: 'aGVsbG8=',
    });
    agentPeer.send(frame);
    expect(await phonePeer.next('data')).toEqual(frame);
    expect(relay.router.trackedDeliveries).toBe(1);

    phonePeer.send({ v: 1, kind: 'ack', ids: [envelopeId(1), envelopeId(500)] });
    expect(await agentPeer.next('ack')).toEqual({ v: 1, kind: 'ack', ids: [envelopeId(1)] });
    expect(relay.router.trackedDeliveries).toBe(0);

    // A second ack for the same id is ignored (nothing forwarded).
    phonePeer.send({ v: 1, kind: 'ack', ids: [envelopeId(1)] });
    await phonePeer.sync();
    await agentPeer.sync();
    expect(agentPeer.frames.filter((f) => f.kind === 'ack')).toEqual([]);
  });

  it('fans out to: null to every other device of the user', async () => {
    const relay = await startRelay();
    const { userId, agent, phonePeer, agentPeer } = await pair(relay);
    const second = await addPhone(userId, relay.time.clock.now());
    const secondPeer = await WsPeer.open(relay.url, second.headers);
    await secondPeer.hello('phone');

    agentPeer.send(envelope(agent.deviceId, null, 2));
    expect(await phonePeer.next('data')).toMatchObject({ id: envelopeId(2) });
    expect(await secondPeer.next('data')).toMatchObject({ id: envelopeId(2) });
    await agentPeer.sync();
    expect(agentPeer.frames.filter((f) => f.kind === 'data')).toEqual([]);
  });

  it('never delivers a frame across tenants', async () => {
    const relay = await startRelay();
    const alice = await pair(relay);
    const bob = await pair(relay);

    // Bob's agent addresses Alice's phone (online) and Alice's agent.
    bob.agentPeer.send(envelope(bob.agent.deviceId, alice.phone.deviceId, 10));
    expect(await bob.agentPeer.next('error')).toEqual({
      v: 1,
      kind: 'error',
      code: 'unknown_device',
      ref: envelopeId(10),
      message: 'unknown recipient',
    });
    bob.agentPeer.send(envelope(bob.agent.deviceId, null, 11));
    expect(await bob.phonePeer.next('data')).toMatchObject({ id: envelopeId(11) });
    // A device id nobody owns.
    bob.agentPeer.send(envelope(bob.agent.deviceId, '00000000-0000-4000-8000-000000000000', 12));
    expect(await bob.agentPeer.next('error')).toMatchObject({ code: 'unknown_device' });

    // Alice's sockets saw nothing from Bob.
    alice.agentPeer.send(envelope(alice.agent.deviceId, alice.phone.deviceId, 13));
    expect(await alice.phonePeer.next('data')).toMatchObject({ id: envelopeId(13) });
    await alice.phonePeer.sync();
    await alice.agentPeer.sync();
    expect([...alice.phonePeer.frames, ...alice.agentPeer.frames]).toEqual([]);

    expect(relay.router.stats.crossTenantDrops).toBe(2);
    const logs = relay.logs.lines().join('\n');
    expect(logs).toContain('"reason":"cross_tenant"');
    expect(logs).not.toContain('AAAA');
  });

  it('rejects a spoofed sender, an expired envelope and a refused command', async () => {
    const admit = vi.fn<CommandGate['admit']>(() => false);
    const relay = await startRelay({ commandGate: { admit } });
    const { agent, phone, agentPeer, phonePeer } = await pair(relay);

    agentPeer.send(envelope(phone.deviceId, agent.deviceId, 20));
    expect(await agentPeer.next('error')).toMatchObject({ code: 'bad_frame', ref: envelopeId(20) });
    agentPeer.send(envelope(agent.deviceId, agent.deviceId, 21));
    expect(await agentPeer.next('error')).toMatchObject({ code: 'bad_frame', ref: envelopeId(21) });

    const now = relay.time.clock.now();
    agentPeer.send(envelope(agent.deviceId, phone.deviceId, 22, { expiresAt: now }));
    expect(await agentPeer.next('error')).toMatchObject({ code: 'expired', ref: envelopeId(22) });

    phonePeer.send(envelope(phone.deviceId, agent.deviceId, 23, { cls: 'command' }));
    expect(await phonePeer.next('error')).toMatchObject({
      code: 'unverified',
      ref: envelopeId(23),
    });
    expect(admit).toHaveBeenCalledWith(
      expect.objectContaining({ id: envelopeId(23) }),
      expect.objectContaining({ deviceId: phone.deviceId, kind: 'phone' }),
    );

    // Unexpired and admitted traffic still flows.
    admit.mockReturnValue(true);
    phonePeer.send(
      envelope(phone.deviceId, agent.deviceId, 24, { cls: 'command', expiresAt: now + 1 }),
    );
    expect(await agentPeer.next('data')).toMatchObject({ id: envelopeId(24) });
  });

  it('hands requests for an offline or slow phone to the push seam (M0-12)', async () => {
    const relay = await startRelay();
    const { userId, agent, phone, agentPeer, phonePeer } = await pair(relay);

    agentPeer.send(envelope(agent.deviceId, phone.deviceId, 30, { cls: 'request' }));
    await phonePeer.next('data');
    relay.time.advance(2_999);
    expect(relay.pending.unacked).not.toHaveBeenCalled();
    relay.time.advance(1);
    expect(relay.pending.unacked).toHaveBeenCalledWith(
      expect.objectContaining({ envelopeId: envelopeId(30), to: phone.deviceId, watch: true }),
    );

    phonePeer.close();
    await agentPeer.next('presence', (f) => f.online === false);
    agentPeer.send(envelope(agent.deviceId, phone.deviceId, 31, { cls: 'request' }));
    await vi.waitFor(() => expect(relay.pending.undelivered).toHaveBeenCalled());
    expect(relay.pending.undelivered).toHaveBeenCalledWith({
      envelopeId: envelopeId(31),
      userId,
      from: agent.deviceId,
      to: phone.deviceId,
      cls: 'request',
      expiresAt: null,
    });
  });
});

describe('limits (D15)', () => {
  it('closes a socket that sends a frame above 256 KiB with 1009', async () => {
    const relay = await startRelay();
    const { agentPeer } = await pair(relay);
    agentPeer.send('x'.repeat(MAX_FRAME_BYTES + 1));
    expect((await agentPeer.closed).code).toBe(1009);
  });

  it('closes a socket that floods more than 100 frames per second with 1008', async () => {
    const relay = await startRelay();
    const { agentPeer } = await pair(relay);
    for (let t = 0; t < 150; t += 1) agentPeer.send({ v: 1, kind: 'ping', t });
    expect(await agentPeer.closed).toEqual({ code: 1008, reason: 'rate limited' });
  });

  it('pings every 25 s and terminates a peer silent for 35 s', async () => {
    const relay = await startRelay();
    const userId = await addUser();
    const now = relay.time.clock.now();
    const agent = await addAgent(userId, now);
    const phone = await addPhone(userId, now);
    const phonePeer = await WsPeer.open(relay.url, phone.headers);
    await phonePeer.hello('phone');
    const silent = await WsPeer.open(relay.url, agent.headers, { autoPong: false });
    await silent.hello('agent');
    await phonePeer.next('presence');

    relay.time.advance(25_000);
    await vi.waitFor(() => expect(silent.pings).toBe(1));
    // The phone talks at 30 s, so it survives the 35 s mark.
    relay.time.advance(5_000);
    await phonePeer.sync();
    relay.time.advance(4_999);
    expect(relay.router.openSockets).toBe(2);
    relay.time.advance(1);
    expect(await silent.closed).toMatchObject({ code: 1006 });
    expect(await phonePeer.next('presence')).toMatchObject({
      deviceId: agent.deviceId,
      online: false,
      at: now + 35_000,
    });
    expect(relay.logs.lines().join('\n')).toContain('"event":"socket_silent"');

    // `last_seen_at` is refreshed at most once a minute while the phone stays connected.
    // Pings at 25 s and 35 s were answered; the 60 s tick writes `last_seen_at`.
    relay.time.advance(15_000);
    await vi.waitFor(() => expect(phonePeer.pings).toBe(2));
    await phonePeer.sync(2);
    relay.time.advance(15_000);
    expect(relay.router.openSockets).toBe(1);
    await vi.waitFor(async () => {
      const [row] = await db.orm
        .select({ lastSeenAt: devices.lastSeenAt })
        .from(devices)
        .where(eq(devices.id, phone.deviceId));
      expect(row?.lastSeenAt?.getTime()).toBe(now + 60_000);
    });
  });

  it('drops frames for a recipient with more than 1 MiB queued', async () => {
    const relay = await startRelay();
    const { userId, agent, phone, agentPeer, phonePeer } = await pair(relay);
    const target = relay.hub.connection(userId, phone.deviceId);
    expect(target).toBeDefined();
    const socket = (target as unknown as { socket: { bufferedAmount: number } }).socket;
    Object.defineProperty(socket, 'bufferedAmount', { value: 2 * 1024 * 1024, configurable: true });

    agentPeer.send(envelope(agent.deviceId, phone.deviceId, 40));
    expect(await agentPeer.next('error')).toMatchObject({
      code: 'rate_limited',
      ref: envelopeId(40),
    });
    expect(relay.router.stats.backpressureDrops).toBe(1);
    expect(relay.router.trackedDeliveries).toBe(1);
    phonePeer.close();
  });
});

describe('drain (D15, 03 §5.13)', () => {
  it('refuses new upgrades with 503 and closes every socket with 1012 on close', async () => {
    const relay = await startRelay();
    const { agent, agentPeer, phonePeer } = await pair(relay);
    const lonely = await WsPeer.open(relay.url, agent.headers);

    relay.drain.begin();
    expect(await WsPeer.rejection(relay.url, agent.headers)).toBe(503);
    expect((await relay.app.inject('/health')).statusCode).toBe(503);

    running.splice(running.indexOf(relay), 1);
    await relay.app.close();
    const expected = { code: 1012, reason: 'service restart' };
    expect(await agentPeer.closed).toEqual(expected);
    expect(await phonePeer.closed).toEqual(expected);
    expect(await lonely.closed).toEqual(expected);
    await vi.waitFor(() => expect(relay.router.openSockets).toBe(0));
    expect(relay.logs.lines().join('\n')).toContain('"event":"ws_drain"');
  });
});

describe('SIGTERM with open sockets (D15, 03 §5.13)', () => {
  it('closes every socket with 1012 and exits 0', async () => {
    const pglite = new PGlite();
    const serverDb = createPgliteDb(pglite, { migrationsFolder: MIGRATIONS_DIR });
    const exit = vi.fn<(code: number) => void>();
    const destination = createMemoryDestination();
    const { app, shutdown } = await startServer({
      env: { RC_HOST: '127.0.0.1', RC_PORT: '0', RC_PUBLIC_DIR: '/nonexistent-rc-public' },
      signals: new EventEmitter(),
      exit,
      destination,
      db: serverDb,
    });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const url = `ws://127.0.0.1:${address.port}/ws`;

    const [user] = await serverDb.orm
      .insert(users)
      .values({ webauthnUserId: 'drain-user' })
      .returning({ id: users.id });
    const peers: WsPeer[] = [];
    for (const name of ['one', 'two']) {
      const [device] = await serverDb.orm
        .insert(devices)
        .values({ userId: user!.id, kind: 'agent', name })
        .returning({ id: devices.id });
      const token = `rc-agent-drain-${name}`;
      await serverDb.orm.insert(agentTokens).values({
        userId: user!.id,
        agentDeviceId: device!.id,
        tokenHash: await sha256(utf8(token)),
      });
      const peer = await WsPeer.open(url, { authorization: `Bearer ${token}` });
      await peer.hello('agent');
      peers.push(peer);
    }

    await shutdown('SIGTERM');
    for (const peer of peers) {
      expect(await peer.closed).toEqual({ code: 1012, reason: 'service restart' });
    }
    expect(exit).toHaveBeenCalledWith(0);
    expect(pglite.closed).toBe(true);
    const lines = destination.lines().join('\n');
    expect(lines).toContain('"event":"ws_drain"');
    expect(lines).toContain('"sockets":2');
  });
});

describe('GET /api/state (D23)', () => {
  it('requires a session and a numeric cursor', async () => {
    const relay = await startRelay();
    expect((await relay.app.inject('/api/state')).statusCode).toBe(401);
    expect((await relay.app.inject('/api/state?since=yesterday')).statusCode).toBe(400);
  });

  it('reports devices with presence and only what changed after `since`', async () => {
    const relay = await startRelay();
    const { userId, agent, phone } = await pair(relay);
    const cookie = phone.headers.cookie!;
    const start = relay.time.clock.now();
    const other = await addAgent(userId, start - 1_000, 'old box');

    const full = await relay.app.inject({ url: '/api/state', headers: { cookie } });
    expect(full.statusCode).toBe(200);
    const body = full.json<StateBody>();
    expect(body).toMatchObject({ relayTs: start, cursor: start });
    expect(body.devices).toHaveLength(3);
    expect(body.devices).toEqual(
      expect.arrayContaining([
        {
          deviceId: agent.deviceId,
          kind: 'agent',
          name: 'mac',
          online: true,
          lastSeen: start,
          revoked: false,
        },
        {
          deviceId: phone.deviceId,
          kind: 'phone',
          name: 'Pixel',
          online: true,
          lastSeen: start,
          revoked: false,
        },
        {
          deviceId: other.deviceId,
          kind: 'agent',
          name: 'old box',
          online: false,
          lastSeen: null,
          revoked: false,
        },
      ]),
    );

    relay.time.advance(5_000);
    await db.orm
      .update(devices)
      .set({ revokedAt: new Date(start + 5_000) })
      .where(eq(devices.id, other.deviceId));
    const delta = await relay.app.inject({
      url: `/api/state?since=${start}`,
      headers: { cookie },
    });
    expect(delta.json()).toEqual({
      relayTs: start + 5_000,
      cursor: start + 5_000,
      devices: [
        {
          deviceId: other.deviceId,
          kind: 'agent',
          name: 'old box',
          online: false,
          lastSeen: null,
          revoked: true,
        },
      ],
    });
  });
});

describe('rawText', () => {
  it('decodes every shape ws can deliver', () => {
    expect(rawText(Buffer.from('a'))).toBe('a');
    expect(rawText([Buffer.from('a'), Buffer.from('b')])).toBe('ab');
    expect(rawText(new TextEncoder().encode('c').buffer)).toBe('c');
  });
});
