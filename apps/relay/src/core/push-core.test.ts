import { createLogger, createMemoryDestination } from '@remote-control/log';
import { describe, expect, it, vi } from 'vitest';

import type { DeviceDirectory, DeviceRecord } from '../ports/device-directory.js';
import type { PushPort, PushResult } from '../ports/push.js';
import type {
  PushSubscriptionRecord,
  PushSubscriptionStore,
} from '../ports/push-subscription-store.js';
import type { UndeliveredEnvelope } from '../ports/relay-seams.js';
import { createFakeTime } from '../testing/fake-time.js';
import { isKnownPushService } from './push-endpoint.js';
import { PushNotifier, type PushLimits } from './push-notifier.js';
import {
  encodePendingPayload,
  MAX_PUSH_PAYLOAD_BYTES,
  MAX_PUSH_TTL_SECONDS,
  pushTopic,
  pushTtlSeconds,
} from './push-payload.js';

const RID = '01900000-0000-7000-8000-000000000001';
const bytes = (text: string) => new TextEncoder().encode(text).length;

describe('encodePendingPayload (D5)', () => {
  it('is exactly {t, rid, dev, exp} and under 200 bytes', () => {
    const json = encodePendingPayload(RID, 'mac-studio', 1_790_000_000_000);
    expect(JSON.parse(json)).toEqual({
      t: 'pending',
      rid: RID,
      dev: 'mac-studio',
      exp: 1_790_000_000_000,
    });
    expect(bytes(json)).toBeLessThan(200);
    expect(JSON.parse(encodePendingPayload(RID, '', null))).toEqual({
      t: 'pending',
      rid: RID,
      dev: '',
      exp: null,
    });
  });

  it('shortens a long or multi-byte device name until the payload fits', () => {
    for (const name of ['m'.repeat(500), '🖥️'.repeat(200), 'Ж'.repeat(150), '"\\'.repeat(100)]) {
      const json = encodePendingPayload(RID, name, 9_999_999_999_999);
      expect(bytes(json)).toBeLessThanOrEqual(MAX_PUSH_PAYLOAD_BYTES);
      const { dev } = JSON.parse(json) as { dev: string };
      expect(dev.endsWith('…')).toBe(true);
      expect(name.startsWith(dev.slice(0, -1))).toBe(true);
    }
  });

  it('drops the name entirely when even one character does not fit', () => {
    const huge = 'x'.repeat(170);
    expect(JSON.parse(encodePendingPayload(huge, '🖥', null))).toMatchObject({ dev: '' });
  });
});

describe('pushTopic / pushTtlSeconds (D5)', () => {
  it('uses the request id without hyphens as a 32-character topic', () => {
    expect(pushTopic(RID)).toBe('01900000000070008000000000000001');
    expect(pushTopic(RID)).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('is the remaining lifetime rounded up, capped, and 0 once expired', () => {
    const now = 1_000_000;
    expect(pushTtlSeconds(now + 299_001, now)).toBe(300);
    expect(pushTtlSeconds(now + 1, now)).toBe(1);
    expect(pushTtlSeconds(now, now)).toBe(0);
    expect(pushTtlSeconds(now - 5_000, now)).toBe(0);
    expect(pushTtlSeconds(now + 10 * 3_600_000, now)).toBe(MAX_PUSH_TTL_SECONDS);
    expect(pushTtlSeconds(null, now)).toBe(MAX_PUSH_TTL_SECONDS);
  });
});

describe('isKnownPushService', () => {
  it('accepts the browser push services over https only', () => {
    for (const url of [
      'https://fcm.googleapis.com/fcm/send/abc:def',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
      'https://web.push.apple.com/QOk3',
      'https://wns2-par02p.notify.windows.com/w/?token=x',
    ]) {
      expect(isKnownPushService(url)).toBe(true);
    }
    for (const url of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com:8443/fcm/send/abc',
      'https://user:pw@fcm.googleapis.com/x',
      'https://evil.example/fcm.googleapis.com',
      'https://fcm.googleapis.com.evil.example/x',
      'https://127.0.0.1/push',
      'https://evilpush.apple.com/x',
      'not a url',
      `https://fcm.googleapis.com/${'a'.repeat(2048)}`,
    ]) {
      expect(isKnownPushService(url)).toBe(false);
    }
  });
});

const USER = 'user-1';
const PHONE = 'phone-1';
const AGENT = 'agent-1';

function device(id: string, kind: DeviceRecord['kind'], extra: Partial<DeviceRecord> = {}) {
  return {
    id,
    kind,
    name: kind === 'agent' ? 'mac-studio' : 'Pixel',
    createdAt: 0,
    lastSeenAt: null,
    revokedAt: null,
    ...extra,
  };
}

function setup(options: { limits?: PushLimits; result?: PushResult } = {}) {
  const time = createFakeTime();
  const logs = createMemoryDestination();
  const logger = createLogger({ level: 'debug', destination: logs });
  const devices: DeviceRecord[] = [device(AGENT, 'agent'), device(PHONE, 'phone')];
  const listDevices = vi.fn<DeviceDirectory['listDevices']>(() => Promise.resolve(devices));
  const directory = { listDevices } as unknown as DeviceDirectory;
  const subscriptions: PushSubscriptionRecord[] = [
    {
      id: 'sub-1',
      deviceId: PHONE,
      endpoint: 'https://fcm.googleapis.com/fcm/send/secret-endpoint-1',
      p256dh: 'BPUB',
      auth: 'AUTH',
      createdAt: 0,
      lastFailureAt: null,
    },
  ];
  const remove = vi.fn<PushSubscriptionStore['remove']>(() => Promise.resolve());
  const markFailure = vi.fn<PushSubscriptionStore['markFailure']>(() => Promise.resolve());
  const store = {
    listForDevice: (id: string) =>
      Promise.resolve(subscriptions.filter((row) => row.deviceId === id)),
    remove,
    markFailure,
  } as unknown as PushSubscriptionStore;
  const send = vi.fn<PushPort['send']>(() => Promise.resolve(options.result ?? { kind: 'sent' }));
  const notifier = new PushNotifier({
    clock: time.clock,
    directory,
    store,
    push: { send },
    logger,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  const request = (n: number, extra: Partial<UndeliveredEnvelope> = {}): UndeliveredEnvelope => ({
    envelopeId: `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`,
    userId: USER,
    from: AGENT,
    to: PHONE,
    cls: 'request',
    expiresAt: time.clock.now() + 120_000,
    ...extra,
  });
  return {
    time,
    logs,
    devices,
    listDevices,
    subscriptions,
    remove,
    markFailure,
    send,
    notifier,
    request,
  };
}

describe('PushNotifier (M0-12, D4, D5)', () => {
  it('pushes metadata only to every subscription of an offline phone', async () => {
    const { notifier, send, subscriptions, request, logs, time } = setup();
    subscriptions.push({
      ...subscriptions[0]!,
      id: 'sub-2',
      endpoint: 'https://web.push.apple.com/secret-2',
    });
    const envelope = request(1);
    notifier.undelivered(envelope);
    await notifier.idle();
    expect(send).toHaveBeenCalledTimes(2);
    const [target, message] = send.mock.calls[0]!;
    expect(target).toBe(subscriptions[0]);
    expect(message).toEqual({
      payload: JSON.stringify({
        t: 'pending',
        rid: envelope.envelopeId,
        dev: 'mac-studio',
        exp: time.clock.now() + 120_000,
      }),
      topic: pushTopic(envelope.envelopeId),
      ttlSeconds: 120,
      urgency: 'high',
    });
    const lines = logs.lines().join('\n');
    expect(lines).toContain('"event":"push_sent"');
    expect(lines).not.toContain('secret-endpoint');
    expect(lines).not.toContain('BPUB');
  });

  it('does not block the caller: the push runs after undelivered() returns', async () => {
    const { notifier, send, request } = setup();
    let release!: (result: PushResult) => void;
    send.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    expect(notifier.undelivered(request(1))).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    release({ kind: 'sent' });
    await notifier.idle();
  });

  it('pushes for an unacked watched delivery and ignores unwatched ones', async () => {
    const { notifier, send, request } = setup();
    notifier.unacked({ ...request(1), watch: false });
    notifier.unacked({ ...request(2), watch: true });
    await notifier.idle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0]![1].payload)).toMatchObject({
      rid: request(2).envelopeId,
    });
  });

  it('ignores other classes, expired requests and targets that are not live phones', async () => {
    const { notifier, send, request, devices, logs } = setup();
    for (const cls of ['reply', 'command', 'event', 'control'] as const) {
      notifier.undelivered(request(1, { cls }));
    }
    notifier.undelivered(request(2, { expiresAt: 0 }));
    notifier.undelivered(request(3, { to: AGENT }));
    notifier.undelivered(request(4, { to: 'unknown' }));
    devices[1] = device(PHONE, 'phone', { revokedAt: 1 });
    notifier.undelivered(request(5));
    await notifier.idle();
    expect(send).not.toHaveBeenCalled();
    expect(logs.lines().join('\n')).toContain('"why":"expired"');
  });

  it('logs and skips a phone without subscriptions; a missing sender name is empty', async () => {
    const { notifier, send, request, subscriptions, logs } = setup();
    subscriptions.length = 0;
    notifier.undelivered(request(1));
    await notifier.idle();
    expect(send).not.toHaveBeenCalled();
    expect(logs.lines().join('\n')).toContain('"why":"no_subscription"');

    const second = setup();
    second.notifier.undelivered(second.request(2, { from: 'gone-agent', expiresAt: null }));
    await second.notifier.idle();
    const message = second.send.mock.calls[0]![1];
    expect(JSON.parse(message.payload)).toMatchObject({ dev: '', exp: null });
    expect(message.ttlSeconds).toBe(3600);
  });

  it('pushes a request once even when it is undelivered, unacked and re-sent', async () => {
    const { notifier, send, request } = setup();
    notifier.undelivered(request(1));
    await notifier.idle();
    notifier.unacked({ ...request(1), watch: true });
    notifier.undelivered(request(1));
    await notifier.idle();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('caps pushes per device and recovers after the window', async () => {
    const limits: PushLimits = {
      perDevice: { max: 3, windowMs: 60_000 },
      perRequest: { max: 1, windowMs: 60_000 },
    };
    const { notifier, send, request, time, logs } = setup({ limits });
    for (let n = 1; n <= 5; n += 1) notifier.undelivered(request(n));
    await notifier.idle();
    expect(send).toHaveBeenCalledTimes(3);
    expect(logs.lines().join('\n')).toContain('"why":"rate_limited"');
    time.advance(60_000);
    notifier.undelivered(request(6));
    await notifier.idle();
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('deletes a subscription the push service reports gone (404/410)', async () => {
    const { notifier, remove, markFailure, request } = setup({ result: { kind: 'gone' } });
    notifier.undelivered(request(1));
    await notifier.idle();
    expect(remove).toHaveBeenCalledWith('sub-1');
    expect(markFailure).not.toHaveBeenCalled();
  });

  it('marks other failures on the subscription and logs the status only', async () => {
    const { notifier, remove, markFailure, request, logs, time } = setup({
      result: { kind: 'failed', status: 429 },
    });
    notifier.undelivered(request(1));
    await notifier.idle();
    expect(markFailure).toHaveBeenCalledWith('sub-1', time.clock.now());
    expect(remove).not.toHaveBeenCalled();
    const lines = logs.lines().join('\n');
    expect(lines).toContain('"status":429');
    expect(lines).not.toContain('secret-endpoint');
  });

  it('swallows and logs errors by class name only', async () => {
    const { notifier, listDevices, request, logs } = setup();
    listDevices.mockRejectedValueOnce(
      new Error('connect failed for https://fcm.googleapis.com/fcm/send/secret-endpoint-1'),
    );
    notifier.undelivered(request(1));
    listDevices.mockRejectedValueOnce('string failure');
    notifier.undelivered(request(2));
    await notifier.idle();
    const lines = logs.lines().join('\n');
    expect(lines).toContain('"event":"push_error"');
    expect(lines).toContain('"err":"Error"');
    expect(lines).toContain('"err":"string"');
    expect(lines).not.toContain('secret-endpoint');
  });
});
