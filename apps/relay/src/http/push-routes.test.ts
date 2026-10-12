import { PGlite } from '@electric-sql/pglite';
import { sha256, utf8, webCryptoRandom } from '@remote-control/crypto';
import { createLogger, createMemoryDestination, type MemoryDestination } from '@remote-control/log';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDrizzleAccountStore } from '../adapters/drizzle-account-store.js';
import { createDrizzleDeviceDirectory } from '../adapters/drizzle-device-directory.js';
import { createDrizzlePushSubscriptionStore } from '../adapters/drizzle-push-subscription-store.js';
import { createPgliteDb } from '../adapters/pglite-db.js';
import { createScryptSecretHasher } from '../adapters/scrypt-secret-hasher.js';
import { createSimpleWebAuthn } from '../adapters/simple-webauthn.js';
import { createWebPushSender, generateVapidKeys } from '../adapters/web-push-sender.js';
import { buildApp } from '../app.js';
import { AccountService } from '../core/account-service.js';
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
import { MAX_SUBSCRIPTIONS_PER_DEVICE } from './push-routes.js';

const ORIGIN = 'https://rc.example.test';
const DAY = 24 * 60 * 60 * 1000;
const vapid = { ...generateVapidKeys(), subject: 'mailto:owner@example.test' };

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
}

const running: Relay[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((relay) => relay.app.close()));
});

/** A relay wired like `container.ts`: real router, notifier, web-push sender. */
async function startRelay(): Promise<Relay> {
  const time = createFakeTime();
  const logs = createMemoryDestination();
  const logger = createLogger({ level: 'info', destination: logs });
  const directory = createDrizzleDeviceDirectory(db.orm);
  const hub = new LocalHub(time.clock, DEVICE_CAP);
  const notifier = new PushNotifier({
    clock: time.clock,
    directory,
    store,
    push: createWebPushSender(vapid),
    logger,
  });
  const router = new RelayRouter({
    clock: time.clock,
    timer: time.timer,
    hub,
    directory,
    logger,
    pending: notifier,
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
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const relay = { app, url: `ws://127.0.0.1:${address.port}/ws`, time, logs, notifier };
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
