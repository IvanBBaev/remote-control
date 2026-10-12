import { PGlite } from '@electric-sql/pglite';
import { sha256, utf8, webCryptoRandom } from '@remote-control/crypto';
import {
  assertNoCanary,
  createLogger,
  createMemoryDestination,
  type MemoryDestination,
} from '@remote-control/log';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDrizzleAccountStore } from '../adapters/drizzle-account-store.js';
import { createDrizzleAuditLog } from '../adapters/drizzle-audit-log.js';
import { createDrizzleDeviceDirectory } from '../adapters/drizzle-device-directory.js';
import { createDrizzlePushSubscriptionStore } from '../adapters/drizzle-push-subscription-store.js';
import { createPgliteDb } from '../adapters/pglite-db.js';
import { createScryptSecretHasher } from '../adapters/scrypt-secret-hasher.js';
import { createSimpleWebAuthn } from '../adapters/simple-webauthn.js';
import { createWebPushSender, generateVapidKeys } from '../adapters/web-push-sender.js';
import { buildApp } from '../app.js';
import { AccountService } from '../core/account-service.js';
import { AuditRecorder } from '../core/audit-recorder.js';
import { DrainState } from '../core/drain-state.js';
import { DEVICE_CAP } from '../core/hub-limits.js';
import { LocalHub } from '../core/local-hub.js';
import { PushNotifier } from '../core/push-notifier.js';
import { RelayRouter } from '../core/relay-router.js';
import { agentTokens, devices, sessions, users } from '../db/schema.js';
import { MIGRATIONS_DIR } from '../package-paths.js';
import type { Db } from '../ports/db.js';
import type { PushTarget } from '../ports/push.js';
import type { PushSubscriptionStore } from '../ports/push-subscription-store.js';
import { FakePushService } from '../testing/fake-push-service.js';
import { createFakeTime, type FakeTime } from '../testing/fake-time.js';
import { WsPeer } from '../testing/ws-peer.js';
import { COUNTER_DAYS, DEFAULT_ADMIN_LIMIT } from './admin-routes.js';
import { MAX_SUBSCRIPTIONS_PER_DEVICE } from './push-routes.js';

const ORIGIN = 'https://rc.example.test';
const DAY = 24 * 60 * 60 * 1000;
const vapid = { ...generateVapidKeys(), subject: 'mailto:owner@example.test' };
const ADMIN_TOKEN = 'admin-canary-token-0123456789abcdef0123456789';

const client = new PGlite();
let db: Db;
let store: PushSubscriptionStore;
let service: FakePushService;

beforeAll(async () => {
  db = createPgliteDb(client, { migrationsFolder: MIGRATIONS_DIR });
  await db.migrate();
  store = createDrizzlePushSubscriptionStore(db.orm);
  service = await FakePushService.start(vapid.publicKey);
});

afterAll(async () => {
  await service.close();
  await client.close();
});

let counter = 0;
const unique = () => (counter += 1);
const envelopeId = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

interface Relay {
  readonly app: FastifyInstance;
  readonly url: string;
  readonly time: FakeTime;
  readonly logs: MemoryDestination;
  readonly notifier: PushNotifier;
  readonly audit: AuditRecorder;
}

const running: Relay[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((relay) => relay.app.close()));
});

/** A relay wired like `container.ts`: real router, notifier, web-push sender, audit log. */
async function startRelay(options: { admin?: boolean } = {}): Promise<Relay> {
  const time = createFakeTime();
  const logs = createMemoryDestination();
  const logger = createLogger({ level: 'info', destination: logs });
  const directory = createDrizzleDeviceDirectory(db.orm);
  const hub = new LocalHub(time.clock, DEVICE_CAP);
  const auditLog = createDrizzleAuditLog(db.orm);
  const audit = new AuditRecorder({ clock: time.clock, store: auditLog, logger });
  const notifier = new PushNotifier({
    clock: time.clock,
    directory,
    store,
    push: createWebPushSender(vapid),
    logger,
    audit,
  });
  const router = new RelayRouter({
    clock: time.clock,
    timer: time.timer,
    hub,
    directory,
    logger,
    pending: notifier,
    audit,
  });
  const accounts = new AccountService({
    store: createDrizzleAccountStore(db.orm),
    webauthn: createSimpleWebAuthn({ id: 'rc.example.test', origin: ORIGIN, name: 'rc' }),
    hasher: createScryptSecretHasher(webCryptoRandom),
    clock: time.clock,
    random: webCryptoRandom,
  });
  const app = await buildApp({
    logger,
    clock: time.clock,
    database: db,
    drain: new DrainState(),
    version: '0.0.0',
    commit: null,
    publicDir: undefined,
    auth: { service: accounts, origin: ORIGIN },
    relay: { router, hub, directory },
    // The fake push service is plain http on 127.0.0.1; production keeps the allow-list.
    push: {
      store,
      publicKey: vapid.publicKey,
      allowEndpoint: (url) => url.startsWith(service.origin),
    },
    ...(options.admin === true && { admin: { token: ADMIN_TOKEN, stats: auditLog } }),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const relay = { app, url: `ws://127.0.0.1:${address.port}/ws`, time, logs, notifier, audit };
  running.push(relay);
  return relay;
}

async function addUser(): Promise<string> {
  const [user] = await db.orm
    .insert(users)
    .values({ webauthnUserId: `user-${unique()}` })
    .returning({ id: users.id });
  return user!.id;
}

async function addDevice(userId: string, kind: 'phone' | 'agent', name: string, now: number) {
  const [device] = await db.orm
    .insert(devices)
    .values({ userId, kind, name, createdAt: new Date(now) })
    .returning({ id: devices.id });
  return device!.id;
}

/** A session cookie, bound to `deviceId` when given (a phone) or unbound. */
async function addSession(userId: string, deviceId: string | null, now: number) {
  const token = `push${unique()}`.padEnd(43, 'x');
  await db.orm.insert(sessions).values({
    userId,
    deviceId,
    tokenHash: await sha256(utf8(token)),
    lastSeenAt: new Date(now),
    expiresAt: new Date(now + 30 * DAY),
  });
  return {
    origin: ORIGIN,
    'sec-fetch-site': 'same-origin',
    'x-rc-client': 'pwa',
    cookie: `__Host-rc_session=${token}`,
  };
}

async function addPhone(userId: string, now: number) {
  const deviceId = await addDevice(userId, 'phone', 'Pixel', now);
  return { deviceId, headers: await addSession(userId, deviceId, now) };
}

async function addAgent(userId: string, now: number, name = 'mac-studio') {
  const deviceId = await addDevice(userId, 'agent', name, now);
  const token = `rc-agent-${unique()}`;
  await db.orm.insert(agentTokens).values({
    userId,
    agentDeviceId: deviceId,
    tokenHash: await sha256(utf8(token)),
  });
  return { deviceId, headers: { authorization: `Bearer ${token}` } };
}

const toJson = (target: PushTarget) => ({
  endpoint: target.endpoint,
  expirationTime: null,
  keys: { p256dh: target.p256dh, auth: target.auth },
});

function request(from: string, to: string, n: number, expiresAt: number | null = null) {
  return {
    v: 1,
    kind: 'data',
    id: envelopeId(n),
    from,
    to,
    session: null,
    cls: 'request',
    seq: n,
    ts: 0,
    expiresAt,
    payload: 'U0VDUkVU',
  };
}

describe('drizzle push subscription store (M0-12)', () => {
  it('saves, lists, moves within a user and refuses another user’s endpoint', async () => {
    const now = 1_000;
    const userId = await addUser();
    const phoneA = await addDevice(userId, 'phone', 'A', now);
    const phoneB = await addDevice(userId, 'phone', 'B', now);
    const sub = { userId, endpoint: `https://x.test/${unique()}`, p256dh: 'P1', auth: 'A1' };
    expect(await store.save({ ...sub, deviceId: phoneA }, 5, now)).toBe('saved');
    expect(await store.listForDevice(phoneA)).toEqual([
      {
        id: expect.any(String) as unknown,
        deviceId: phoneA,
        endpoint: sub.endpoint,
        p256dh: 'P1',
        auth: 'A1',
        createdAt: now,
        lastFailureAt: null,
      },
    ]);
    await store.markFailure((await store.listForDevice(phoneA))[0]!.id, now + 5);
    expect((await store.listForDevice(phoneA))[0]!.lastFailureAt).toBe(now + 5);

    // Re-registering the endpoint on another phone of the same user moves it and resets it.
    expect(await store.save({ ...sub, deviceId: phoneB, p256dh: 'P2' }, 5, now + 10)).toBe('saved');
    expect(await store.listForDevice(phoneA)).toEqual([]);
    expect(await store.listForDevice(phoneB)).toEqual([
      expect.objectContaining({ p256dh: 'P2', createdAt: now + 10, lastFailureAt: null }),
    ]);

    const stranger = await addUser();
    const strangerPhone = await addDevice(stranger, 'phone', 'S', now);
    expect(await store.save({ ...sub, userId: stranger, deviceId: strangerPhone }, 5, now)).toBe(
      'taken',
    );
    expect(await store.listForDevice(phoneB)).toHaveLength(1);
  });

  it('keeps at most N subscriptions per device, evicting the oldest', async () => {
    const userId = await addUser();
    const phone = await addDevice(userId, 'phone', 'A', 0);
    const endpoints = [1, 2, 3, 4].map(() => `https://x.test/${unique()}`);
    for (const [index, endpoint] of endpoints.entries()) {
      await store.save({ userId, deviceId: phone, endpoint, p256dh: 'P', auth: 'A' }, 3, index);
    }
    expect((await store.listForDevice(phone)).map((row) => row.endpoint)).toEqual(
      endpoints.slice(1),
    );
    // Refreshing the oldest one makes it the newest instead of evicting it.
    await store.save(
      { userId, deviceId: phone, endpoint: endpoints[1]!, p256dh: 'P', auth: 'A' },
      3,
      9,
    );
    expect((await store.listForDevice(phone)).map((row) => row.endpoint)).toEqual([
      endpoints[2],
      endpoints[3],
      endpoints[1],
    ]);
  });

  it('removes by endpoint (scoped to the device) and by id', async () => {
    const userId = await addUser();
    const phone = await addDevice(userId, 'phone', 'A', 0);
    const other = await addDevice(userId, 'phone', 'B', 0);
    const endpoint = `https://x.test/${unique()}`;
    await store.save({ userId, deviceId: phone, endpoint, p256dh: 'P', auth: 'A' }, 5, 0);
    expect(await store.removeEndpoint(other, endpoint)).toBe(false);
    expect(await store.removeEndpoint(phone, endpoint)).toBe(true);
    expect(await store.removeEndpoint(phone, endpoint)).toBe(false);
    await store.save({ userId, deviceId: phone, endpoint, p256dh: 'P', auth: 'A' }, 5, 0);
    await store.remove((await store.listForDevice(phone))[0]!.id);
    expect(await store.listForDevice(phone)).toEqual([]);
  });
});

describe('push subscription routes (M0-12, D8, D19)', () => {
  it('serves the VAPID key and round-trips a subscription', async () => {
    const relay = await startRelay();
    const now = relay.time.clock.now();
    const phone = await addPhone(await addUser(), now);
    const target = await service.subscribe();

    const key = await relay.app.inject({
      method: 'GET',
      url: '/api/push/key',
      headers: phone.headers,
    });
    expect(key.statusCode).toBe(200);
    expect(key.json()).toEqual({ publicKey: vapid.publicKey });
    expect(key.headers['cache-control']).toBe('no-store');

    const put = await relay.app.inject({
      method: 'PUT',
      url: '/api/push/subscription',
      headers: phone.headers,
      payload: toJson(target),
    });
    expect(put.statusCode).toBe(204);

    const list = await relay.app.inject({
      method: 'GET',
      url: '/api/push/subscription',
      headers: phone.headers,
    });
    expect(list.statusCode).toBe(200);
    const body = list.json<{ subscriptions: { id: string }[] }>();
    expect(body.subscriptions).toEqual([
      { id: expect.any(String) as unknown, createdAt: now, lastFailureAt: null },
    ]);
    expect(list.body).not.toContain(target.endpoint);

    const del = await relay.app.inject({
      method: 'DELETE',
      url: '/api/push/subscription',
      headers: phone.headers,
      payload: { endpoint: target.endpoint },
    });
    expect(del.statusCode).toBe(204);
    expect(await store.listForDevice(phone.deviceId)).toEqual([]);
    // Deleting again is idempotent.
    const again = await relay.app.inject({
      method: 'DELETE',
      url: '/api/push/subscription',
      headers: phone.headers,
      payload: { endpoint: target.endpoint },
    });
    expect(again.statusCode).toBe(204);

    const lines = relay.logs.lines().join('\n');
    expect(lines).toContain('"event":"push_subscribed"');
    expect(lines).toContain('"event":"push_unsubscribed"');
    expect(lines).not.toContain(target.endpoint);
    expect(lines).not.toContain(target.p256dh);
  });

  it('rejects bad bodies, foreign endpoints and endpoints owned by another user', async () => {
    const relay = await startRelay();
    const now = relay.time.clock.now();
    const phone = await addPhone(await addUser(), now);
    const target = await service.subscribe();
    const put = (headers: Record<string, string>, payload: unknown) =>
      relay.app.inject({
        method: 'PUT',
        url: '/api/push/subscription',
        headers,
        payload: payload as object,
      });

    for (const payload of [
      {},
      { ...toJson(target), keys: { p256dh: 'short', auth: target.auth } },
      { ...toJson(target), keys: { p256dh: target.p256dh, auth: 'x' } },
      { ...toJson(target), endpoint: 'https://evil.example/push' },
      { ...toJson(target), endpoint: '' },
    ]) {
      const response = await put(phone.headers, payload);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'bad_subscription' });
    }
    const bad = await relay.app.inject({
      method: 'DELETE',
      url: '/api/push/subscription',
      headers: phone.headers,
      payload: { endpoint: 42 },
    });
    expect(bad.statusCode).toBe(400);

    expect((await put(phone.headers, toJson(target))).statusCode).toBe(204);
    const stranger = await addPhone(await addUser(), now);
    const taken = await put(stranger.headers, toJson(target));
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toEqual({ error: 'endpoint_taken' });
  });

  it('caps subscriptions per phone', async () => {
    const relay = await startRelay();
    const phone = await addPhone(await addUser(), relay.time.clock.now());
    for (let n = 0; n <= MAX_SUBSCRIPTIONS_PER_DEVICE; n += 1) {
      relay.time.advance(1);
      const response = await relay.app.inject({
        method: 'PUT',
        url: '/api/push/subscription',
        headers: phone.headers,
        payload: toJson(await service.subscribe()),
      });
      expect(response.statusCode).toBe(204);
    }
    expect(await store.listForDevice(phone.deviceId)).toHaveLength(MAX_SUBSCRIPTIONS_PER_DEVICE);
  });

  it('needs a session (401), a phone bound to it (403) and the PWA origin (403)', async () => {
    const relay = await startRelay();
    const now = relay.time.clock.now();
    const userId = await addUser();
    const anonymous = await relay.app.inject({ method: 'GET', url: '/api/push/key' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers['set-cookie']).toContain('__Host-rc_session=');

    const unbound = await addSession(userId, null, now);
    const noPhone = await relay.app.inject({
      method: 'GET',
      url: '/api/push/subscription',
      headers: unbound,
    });
    expect(noPhone.statusCode).toBe(403);
    expect(noPhone.json()).toEqual({ error: 'no_phone' });

    const phone = await addPhone(userId, now);
    const crossSite = await relay.app.inject({
      method: 'PUT',
      url: '/api/push/subscription',
      headers: { ...phone.headers, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      payload: toJson(await service.subscribe()),
    });
    expect(crossSite.statusCode).toBe(403);
    expect(await store.listForDevice(phone.deviceId)).toEqual([]);
  });

  it('rate-limits subscription calls per account', async () => {
    const relay = await startRelay();
    const phone = await addPhone(await addUser(), relay.time.clock.now());
    const statuses: number[] = [];
    for (let n = 0; n < 31; n += 1) {
      statuses.push(
        (await relay.app.inject({ method: 'GET', url: '/api/push/key', headers: phone.headers }))
          .statusCode,
      );
    }
    expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
    const limited = await relay.app.inject({
      method: 'GET',
      url: '/api/push/key',
      headers: phone.headers,
    });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    relay.time.advance(60_000);
    expect(
      (await relay.app.inject({ method: 'GET', url: '/api/push/key', headers: phone.headers }))
        .statusCode,
    ).toBe(200);
  });
});

describe('request → push end to end (M0-12, D4, D5)', () => {
  async function paired(relay: Relay) {
    const userId = await addUser();
    const now = relay.time.clock.now();
    const agent = await addAgent(userId, now);
    const phone = await addPhone(userId, now);
    const target = await service.subscribe();
    const put = await relay.app.inject({
      method: 'PUT',
      url: '/api/push/subscription',
      headers: phone.headers,
      payload: toJson(target),
    });
    expect(put.statusCode).toBe(204);
    const agentPeer = await WsPeer.open(relay.url, agent.headers);
    await agentPeer.hello('agent');
    const wsHeaders = Object.fromEntries(
      Object.entries(phone.headers).filter(([name]) => name !== 'x-rc-client'),
    );
    return { agent, phone, target, agentPeer, wsHeaders };
  }

  const pushesTo = (endpoint: string) =>
    service.received.filter((push) => push.endpoint === endpoint);

  it('pushes metadata once for a request to an offline phone', async () => {
    const relay = await startRelay();
    const { agent, phone, target, agentPeer } = await paired(relay);
    const expiresAt = relay.time.clock.now() + 90_000;
    agentPeer.send(request(agent.deviceId, phone.deviceId, 1, expiresAt));
    await vi.waitFor(() => expect(pushesTo(target.endpoint)).toHaveLength(1));
    await relay.notifier.idle();
    const [push] = pushesTo(target.endpoint);
    expect(push!.rejected).toBeNull();
    expect(JSON.parse(push!.plaintext!)).toEqual({
      t: 'pending',
      rid: envelopeId(1),
      dev: 'mac-studio',
      exp: expiresAt,
    });
    expect(push!.plaintext).not.toContain('U0VDUkVU');
    expect(push!.headers).toMatchObject({
      ttl: '90',
      urgency: 'high',
      topic: envelopeId(1).replaceAll('-', ''),
    });
    expect(relay.logs.lines().join('\n')).not.toContain(target.endpoint);
  });

  it('does not push when the phone acks within 3 s, pushes when it does not', async () => {
    const relay = await startRelay();
    const { agent, phone, target, agentPeer, wsHeaders } = await paired(relay);
    const phonePeer = await WsPeer.open(relay.url, wsHeaders);
    await phonePeer.hello('phone');

    agentPeer.send(request(agent.deviceId, phone.deviceId, 2));
    await phonePeer.next('data');
    phonePeer.send({ v: 1, kind: 'ack', ids: [envelopeId(2)] });
    await agentPeer.next('ack');
    relay.time.advance(3_000);
    await relay.notifier.idle();
    expect(pushesTo(target.endpoint)).toHaveLength(0);

    agentPeer.send(request(agent.deviceId, phone.deviceId, 3));
    await phonePeer.next('data', (frame) => frame.id === envelopeId(3));
    relay.time.advance(3_000);
    await vi.waitFor(() => expect(pushesTo(target.endpoint)).toHaveLength(1));
    await relay.notifier.idle();
    expect(JSON.parse(pushesTo(target.endpoint)[0]!.plaintext!)).toMatchObject({
      rid: envelopeId(3),
    });
  });

  it('deletes the subscription when the push service answers 410', async () => {
    const relay = await startRelay();
    const { agent, phone, target, agentPeer } = await paired(relay);
    service.respondWith(target.endpoint, 410);
    agentPeer.send(request(agent.deviceId, phone.deviceId, 4));
    await vi.waitFor(() => expect(pushesTo(target.endpoint)).toHaveLength(1));
    await vi.waitFor(async () => expect(await store.listForDevice(phone.deviceId)).toEqual([]));
  });
});

describe('audit log and admin counters (M1-13, 03 W12, D19)', () => {
  const admin = (relay: Relay, authorization?: string) =>
    relay.app.inject({
      method: 'GET',
      url: '/api/admin/counters',
      headers: authorization === undefined ? {} : { authorization },
    });

  interface Counters {
    readonly users: number;
    readonly devices: { readonly phone: number; readonly agent: number };
    readonly online: { readonly phone: number; readonly agent: number };
    readonly pushesPerDay: readonly { readonly day: string; readonly count: number }[];
  }
  const counters = async (relay: Relay) => {
    const reply = await admin(relay, `Bearer ${ADMIN_TOKEN}`);
    expect(reply.statusCode).toBe(200);
    expect(reply.headers['cache-control']).toBe('no-store');
    return reply.json<Counters>();
  };
  const today = (list: Counters['pushesPerDay'], day: string) =>
    list.find((entry) => entry.day === day)?.count ?? 0;

  it('privacy gate: audit rows carry the decision hash only, never payloads, names or endpoints', async () => {
    const relay = await startRelay({ admin: true });
    const before = await counters(relay);
    const userId = await addUser();
    const now = relay.time.clock.now();
    const agentName = 'canary-agent-name-5d1c';
    const agent = await addAgent(userId, now, agentName);
    const phone = await addPhone(userId, now);
    const target = await service.subscribe();
    await relay.app.inject({
      method: 'PUT',
      url: '/api/push/subscription',
      headers: phone.headers,
      payload: toJson(target),
    });
    const agentPeer = await WsPeer.open(relay.url, agent.headers);
    await agentPeer.hello('agent');

    // A request to the offline phone: one push, one push_sent row.
    const requestPayload = Buffer.from('canary-request-body-9e2a').toString('base64');
    agentPeer.send({ ...request(agent.deviceId, phone.deviceId, 1), payload: requestPayload });
    await vi.waitFor(() =>
      expect(service.received.filter((push) => push.endpoint === target.endpoint)).toHaveLength(1),
    );
    await relay.notifier.idle();

    // The phone comes online and forwards a decision: one decision_forwarded row.
    const wsHeaders = Object.fromEntries(
      Object.entries(phone.headers).filter(([name]) => name !== 'x-rc-client'),
    );
    const phonePeer = await WsPeer.open(relay.url, wsHeaders);
    await phonePeer.hello('phone');
    const hash = 'c0ffee'.repeat(10) + 'beef';
    const commandPayload = Buffer.from('canary-command-body-41b7').toString('base64');
    phonePeer.send({
      ...request(phone.deviceId, agent.deviceId, 2),
      cls: 'command',
      payload: commandPayload,
      decisionHash: hash,
    });
    await agentPeer.next('data', (frame) => frame.id === envelopeId(2));
    await relay.audit.idle();

    const rows = (
      await client.query<Record<string, unknown>>(
        'SELECT * FROM audit_log WHERE user_id = $1 ORDER BY id',
        [userId],
      )
    ).rows.map((row) =>
      JSON.stringify(row, (_key, value: unknown) =>
        value instanceof Uint8Array ? Buffer.from(value).toString('hex') : value,
      ),
    );
    const events = rows.map((row) => JSON.parse(row) as Record<string, unknown>);
    expect(events.filter((row) => row.event === 'push_sent')).toEqual([
      expect.objectContaining({ device_id: phone.deviceId, decision_hash: null }),
    ]);
    expect(events.filter((row) => row.event === 'decision_forwarded')).toEqual([
      expect.objectContaining({ device_id: phone.deviceId, decision_hash: hash }),
    ]);
    const secrets = [
      requestPayload,
      commandPayload,
      'canary-request-body-9e2a',
      'canary-command-body-41b7',
      agentName,
      target.endpoint,
      target.p256dh,
      target.auth,
      agent.headers.authorization.slice('Bearer '.length),
    ];
    assertNoCanary(rows, secrets);
    assertNoCanary(relay.logs.lines(), [...secrets, ADMIN_TOKEN]);

    // Counters: deltas, since the database is shared by the whole file.
    const after = await counters(relay);
    expect(after.users - before.users).toBe(1);
    expect(after.devices.phone - before.devices.phone).toBe(1);
    expect(after.devices.agent - before.devices.agent).toBe(1);
    expect(after.online).toEqual({ phone: 1, agent: 1 });
    const day = new Date(now).toISOString().slice(0, 10);
    expect(today(after.pushesPerDay, day) - today(before.pushesPerDay, day)).toBe(1);
    assertNoCanary(JSON.stringify(after), secrets);
    phonePeer.close();
    agentPeer.close();
  });

  it('counts pushes per UTC day over the last week only', async () => {
    const relay = await startRelay({ admin: true });
    const userId = await addUser();
    const phone = await addDevice(userId, 'phone', 'P', 0);
    const now = relay.time.clock.now();
    const DAY_MS = 86_400_000;
    const start = Math.floor(now / DAY_MS) * DAY_MS;
    const before = (await counters(relay)).pushesPerDay;
    await createDrizzleAuditLog(db.orm).append(
      [start - COUNTER_DAYS * DAY_MS, start - DAY_MS, start - 1, start, start + 5].map((at) => ({
        userId,
        deviceId: phone,
        event: 'push_sent' as const,
        at,
      })),
    );
    const after = (await counters(relay)).pushesPerDay;
    const day = (at: number) => new Date(at).toISOString().slice(0, 10);
    expect(after.map((entry) => entry.day)).toEqual([...after.map((entry) => entry.day)].sort());
    expect(today(after, day(start)) - today(before, day(start))).toBe(2);
    expect(today(after, day(start - 1)) - today(before, day(start - 1))).toBe(2);
    expect(after.some((entry) => entry.day === day(start - COUNTER_DAYS * DAY_MS))).toBe(false);
  });

  it('refuses a missing or wrong token without logging it and rate-limits per IP', async () => {
    const relay = await startRelay({ admin: true });
    for (const authorization of [
      undefined,
      'Bearer wrong-token',
      `Basic ${ADMIN_TOKEN}`,
      `Bearer ${'x'.repeat(300)}`,
    ]) {
      const reply = await admin(relay, authorization);
      expect(reply.statusCode).toBe(401);
      expect(reply.json()).toEqual({ error: 'unauthenticated' });
    }
    expect(relay.logs.lines().join('\n')).toContain('"event":"admin_auth"');
    assertNoCanary(relay.logs.lines(), ['wrong-token', ADMIN_TOKEN]);
    for (let n = 4; n < DEFAULT_ADMIN_LIMIT.max; n += 1) await admin(relay);
    const limited = await admin(relay, `Bearer ${ADMIN_TOKEN}`);
    expect(limited.statusCode).toBe(429);
    relay.time.advance(DEFAULT_ADMIN_LIMIT.windowMs);
    expect((await admin(relay, `Bearer ${ADMIN_TOKEN}`)).statusCode).toBe(200);
  });

  it('has no admin route without RC_ADMIN_TOKEN', async () => {
    const relay = await startRelay();
    expect((await admin(relay, `Bearer ${ADMIN_TOKEN}`)).statusCode).toBe(404);
  });

  it('logs a failed audit write by event and error class only', async () => {
    const logs = createMemoryDestination();
    const recorder = new AuditRecorder({
      clock: createFakeTime().clock,
      store: { append: () => Promise.reject(new TypeError('canary-db-detail')) },
      logger: createLogger({ level: 'info', destination: logs }),
    });
    recorder.pushSent('user', 'phone');
    await recorder.idle();
    const lines = logs.lines().join('\n');
    expect(lines).toContain('"event":"audit_write_failed"');
    expect(lines).toContain('"audit_event":"push_sent"');
    expect(lines).toContain('"err":"TypeError"');
    assertNoCanary(logs.lines(), ['canary-db-detail']);
    await createDrizzleAuditLog(db.orm).append([]);
  });
});
