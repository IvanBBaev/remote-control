import { createLogger, createMemoryDestination, type MemoryDestination } from '@remote-control/log';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { DrainState } from '../core/drain-state.js';
import { SPIKE_DIR } from '../package-paths.js';
import type { PushMessage, PushPort, PushResult, PushTarget } from '../ports/push.js';
import { createFakeTime, type FakeTime } from '../testing/fake-time.js';
import { MAX_PENDING_SPIKE_PUSHES, SPIKE_PUSH_LIMIT } from './spike-routes.js';

const ORIGIN = 'https://rc.example.test';
const PUBLIC_KEY = `B${'A'.repeat(86)}`;
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/spike-canary-endpoint';
const SUBSCRIPTION = {
  endpoint: ENDPOINT,
  keys: { p256dh: `B${'b'.repeat(86)}`, auth: `${'c'.repeat(21)}A` },
};

class RecordingPush implements PushPort {
  readonly sent: { target: PushTarget; message: PushMessage }[] = [];
  result: PushResult = { kind: 'sent' };
  send(target: PushTarget, message: PushMessage): Promise<PushResult> {
    this.sent.push({ target, message });
    return Promise.resolve(this.result);
  }
}

interface Spike {
  readonly app: FastifyInstance;
  readonly push: RecordingPush;
  readonly time: FakeTime;
  readonly logs: MemoryDestination;
}

const running: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((app) => app.close()));
});

async function startSpike(): Promise<Spike> {
  const time = createFakeTime();
  const push = new RecordingPush();
  const logs = createMemoryDestination();
  const app = await buildApp({
    logger: createLogger({ level: 'info', destination: logs }),
    clock: time.clock,
    database: { check: () => Promise.resolve('ok'), close: () => Promise.resolve() },
    drain: new DrainState(),
    version: '0.0.0',
    commit: null,
    publicDir: undefined,
    spike: { dir: SPIKE_DIR, push, publicKey: PUBLIC_KEY, origin: ORIGIN, timer: time.timer },
  });
  running.push(app);
  return { app, push, time, logs };
}

const pwaHeaders = { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'x-rc-client': 'pwa' };

function schedule(
  app: FastifyInstance,
  body: unknown = { subscription: SUBSCRIPTION, payload: 'opaque-ciphertext', delaySeconds: 20 },
  headers: Record<string, string> = pwaHeaders,
) {
  return app.inject({ method: 'POST', url: '/api/spike/push', headers, payload: body as object });
}

/** Lets the `.then` after a fake push send run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('spike page (M0-03)', () => {
  it.each([
    ['/spike/', 'text/html', '<title>'],
    ['/spike/requests/1', 'text/html', '<title>'],
    ['/spike/spike.js', 'text/javascript', 'passkey-create'],
    ['/spike/sw.js', 'text/javascript', 'notificationclick'],
    ['/spike/manifest.webmanifest', 'application/manifest+json', '"scope": "/spike/"'],
    ['/spike/icon.svg', 'image/svg+xml', '<svg'],
  ])('serves %s as %s without long caching', async (url, type, marker) => {
    const { app } = await startSpike();
    const res = await app.inject(url);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain(type);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toContain(marker);
  });

  it('redirects /spike to /spike/', async () => {
    const { app } = await startSpike();
    const res = await app.inject('/spike');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/spike/');
  });

  it('hands out the VAPID public key', async () => {
    const { app } = await startSpike();
    const res = await app.inject('/api/spike/key');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ publicKey: PUBLIC_KEY });
  });

  it('does not exist without the spike deps', async () => {
    const app = await buildApp({
      logger: createLogger({ level: 'silent', destination: createMemoryDestination() }),
      clock: createFakeTime().clock,
      database: { check: () => Promise.resolve('ok'), close: () => Promise.resolve() },
      drain: new DrainState(),
      version: '0.0.0',
      commit: null,
      publicDir: undefined,
    });
    running.push(app);
    expect((await app.inject('/spike/')).statusCode).toBe(404);
    expect((await app.inject('/api/spike/key')).statusCode).toBe(404);
  });
});

describe('POST /api/spike/push', () => {
  it('sends the opaque payload after the delay and never logs the endpoint', async () => {
    const { app, push, time, logs } = await startSpike();
    const res = await schedule(app);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ sendAt: time.clock.now() + 20_000 });
    time.advance(19_999);
    expect(push.sent).toHaveLength(0);
    time.advance(1);
    await flush();
    expect(push.sent).toEqual([
      {
        target: { endpoint: ENDPOINT, ...SUBSCRIPTION.keys },
        message: { payload: 'opaque-ciphertext', topic: 'spike', ttlSeconds: 300, urgency: 'high' },
      },
    ]);
    const lines = logs.lines().join('\n');
    expect(lines).toContain('"event":"spike_push"');
    expect(lines).toContain('"result":"sent"');
    expect(lines).not.toContain(ENDPOINT);
    expect(lines).not.toContain('opaque-ciphertext');
  });

  it('rejects a request without the PWA origin headers', async () => {
    const { app, time } = await startSpike();
    const res = await schedule(app, undefined, { origin: 'https://evil.example' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
    expect(time.pending).toBe(0);
  });

  it.each([
    ['a missing subscription', { payload: 'x', delaySeconds: 0 }],
    ['an empty payload', { subscription: SUBSCRIPTION, payload: '', delaySeconds: 0 }],
    [
      'a payload over 2048 chars',
      { subscription: SUBSCRIPTION, payload: 'x'.repeat(2049), delaySeconds: 0 },
    ],
    ['a delay over the cap', { subscription: SUBSCRIPTION, payload: 'x', delaySeconds: 121 }],
    ['a fractional delay', { subscription: SUBSCRIPTION, payload: 'x', delaySeconds: 1.5 }],
    [
      'a bad p256dh key',
      {
        subscription: { ...SUBSCRIPTION, keys: { ...SUBSCRIPTION.keys, p256dh: 'short' } },
        payload: 'x',
        delaySeconds: 0,
      },
    ],
    [
      'an endpoint outside the known push services',
      {
        subscription: { ...SUBSCRIPTION, endpoint: 'https://attacker.example/push' },
        payload: 'x',
        delaySeconds: 0,
      },
    ],
  ])('rejects %s with 400', async (_name, body) => {
    const { app, time } = await startSpike();
    const res = await schedule(app, body);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_request' });
    expect(time.pending).toBe(0);
  });

  it('rate-limits each caller', async () => {
    const { app } = await startSpike();
    for (let i = 0; i < SPIKE_PUSH_LIMIT.max; i += 1) {
      expect((await schedule(app)).statusCode).toBe(202);
    }
    const res = await schedule(app);
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('caps the pushes waiting for their delay', async () => {
    const { app, time } = await startSpike();
    // Several callers, so the per-IP limit is not what trips.
    for (let i = 0; i < MAX_PENDING_SPIKE_PUSHES; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/spike/push',
        remoteAddress: `10.0.0.${i}`,
        headers: pwaHeaders,
        payload: { subscription: SUBSCRIPTION, payload: 'x', delaySeconds: 60 },
      });
      expect(res.statusCode).toBe(202);
    }
    const res = await app.inject({
      method: 'POST',
      url: '/api/spike/push',
      remoteAddress: '10.0.1.1',
      headers: pwaHeaders,
      payload: { subscription: SUBSCRIPTION, payload: 'x', delaySeconds: 60 },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'busy' });
    time.advance(60_000);
    expect(time.pending).toBe(0);
  });

  it('cancels pending pushes when the relay closes', async () => {
    const { app, push, time } = await startSpike();
    expect((await schedule(app)).statusCode).toBe(202);
    expect(time.pending).toBe(1);
    await app.close();
    expect(time.pending).toBe(0);
    time.advance(60_000);
    expect(push.sent).toHaveLength(0);
  });
});
