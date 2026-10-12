import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { encodePendingPayload } from '../core/push-payload.js';
import type { PushMessage } from '../ports/push.js';
import { FakePushService } from '../testing/fake-push-service.js';
import { createWebPushSender, generateVapidKeys } from './web-push-sender.js';

const vapid = { ...generateVapidKeys(), subject: 'mailto:owner@example.test' };
const RID = '01900000-0000-7000-8000-000000000001';
const message: PushMessage = {
  payload: encodePendingPayload(RID, 'mac-studio', 1_790_000_000_000),
  topic: '01900000000070008000000000000001',
  ttlSeconds: 120,
  urgency: 'high',
};

let service: FakePushService;
beforeAll(async () => {
  service = await FakePushService.start(vapid.publicKey);
});
afterAll(() => service.close());

describe('generateVapidKeys', () => {
  it('returns a P-256 public point and a 32-byte private scalar in base64url', () => {
    const keys = generateVapidKeys();
    expect(keys.publicKey).toMatch(/^B[A-Za-z0-9_-]{86}$/);
    expect(keys.privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateVapidKeys().privateKey).not.toBe(keys.privateKey);
  });
});

describe('createWebPushSender against a fake push service (M0-12, D5)', () => {
  it('sends a VAPID-signed, aes128gcm-encrypted message with TTL, Urgency and Topic', async () => {
    const target = await service.subscribe();
    const result = await createWebPushSender(vapid).send(target, message);
    expect(result).toEqual({ kind: 'sent' });
    const received = service.received.at(-1)!;
    expect(received.rejected).toBeNull();
    expect(received.endpoint).toBe(target.endpoint);
    expect(received.headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    expect(received.claims).toMatchObject({ aud: service.origin, sub: vapid.subject });
    expect(received.headers).toMatchObject({
      ttl: '120',
      urgency: 'high',
      topic: message.topic,
      contentEncoding: 'aes128gcm',
    });
    expect(received.plaintext).toBe(message.payload);
    expect(Buffer.from(received.body).includes(Buffer.from(RID))).toBe(false);
    expect(Buffer.from(received.body).includes(Buffer.from(message.payload))).toBe(false);
    expect(new TextEncoder().encode(received.plaintext!).length).toBeLessThan(200);
  });

  it('reports 404 and 410 as gone and other statuses as failed', async () => {
    const sender = createWebPushSender(vapid);
    for (const [status, expected] of [
      [404, { kind: 'gone' }],
      [410, { kind: 'gone' }],
      [429, { kind: 'failed', status: 429 }],
      [500, { kind: 'failed', status: 500 }],
    ] as const) {
      const target = await service.subscribe();
      service.respondWith(target.endpoint, status);
      expect(await sender.send(target, message)).toEqual(expected);
    }
  });

  it('fails when signed with a key the push service does not expect', async () => {
    const target = await service.subscribe();
    const other = { ...generateVapidKeys(), subject: vapid.subject };
    expect(await createWebPushSender(other).send(target, message)).toEqual({
      kind: 'failed',
      status: 400,
    });
    expect(service.received.at(-1)!.rejected).toBe('vapid key');
  });

  it('turns invalid subscription keys and unreachable services into failures', async () => {
    const target = await service.subscribe();
    const sender = createWebPushSender(vapid);
    expect(await sender.send({ ...target, p256dh: 'bad' }, message)).toEqual({
      kind: 'failed',
      status: null,
    });
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    expect(
      await sender.send(
        { ...target, endpoint: `http://127.0.0.1:${String(port)}/push/0` },
        message,
      ),
    ).toEqual({ kind: 'failed', status: null });
  });

  it('aborts a push service that does not answer in time', async () => {
    const hanging = createServer(() => undefined);
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));
    const { port } = hanging.address() as AddressInfo;
    const target = await service.subscribe();
    const result = await createWebPushSender(vapid, { timeoutMs: 50 }).send(
      { ...target, endpoint: `http://127.0.0.1:${String(port)}/push/0` },
      message,
    );
    expect(result).toEqual({ kind: 'failed', status: null });
    hanging.closeAllConnections();
    await new Promise<void>((resolve) => hanging.close(() => resolve()));
  });
});

describe('FakePushService', () => {
  it('rejects unsigned, plaintext and unknown-endpoint messages', async () => {
    const target = await service.subscribe();
    const plain = await fetch(target.endpoint, {
      method: 'POST',
      headers: { ttl: '60', urgency: 'high', 'content-encoding': 'aes128gcm' },
      body: message.payload,
    });
    expect(plain.status).toBe(400);
    expect(service.received.at(-1)!.rejected).toBe('authorization');
    expect((await fetch(`${service.origin}/push/unknown`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(target.endpoint)).status).toBe(400);
  });
});
