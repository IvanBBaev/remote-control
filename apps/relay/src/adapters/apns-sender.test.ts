// eslint-disable-next-line no-restricted-imports -- test keys for the APNs .p8 (node:crypto adapter).
import { generateKeyPairSync, verify } from 'node:crypto';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { apnsExpiration, encodeApnsAlert, MAX_APNS_PAYLOAD_BYTES } from '../core/apns-payload.js';
import { encodePendingPayload } from '../core/push-payload.js';
import type { ApnsMessage, ApnsTarget } from '../ports/push.js';
import { apnsProviderToken, createApnsSender, parseApnsKey } from './apns-sender.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const config = {
  privateKey: pem,
  keyId: 'ABC123DEFG',
  teamId: 'TEAM123456',
  topic: 'dev.example.app',
};

const RID = '01900000-0000-7000-8000-000000000001';
const SUMMARY = 'c2VhbGVkLXN1bW1hcnk'; // opaque to the relay
const target: ApnsTarget = { token: 'ab'.repeat(32), environment: 'sandbox' };
const message: ApnsMessage = {
  payload: encodeApnsAlert(
    encodePendingPayload(RID, 'mac-studio', 1_790_000_000_000, SUMMARY),
    'agent-1',
  ),
  collapseId: RID,
  expiration: 1_790_000_000,
};

interface Received {
  readonly headers: http2.IncomingHttpHeaders;
  readonly body: string;
}

let server: http2.Http2Server;
let origin: string;
const received: Received[] = [];
let reply: { status: number; reason?: string } = { status: 200 };

beforeAll(async () => {
  server = http2.createServer();
  server.on('stream', (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      received.push({ headers, body: Buffer.concat(chunks).toString('utf8') });
      stream.respond({ ':status': reply.status, 'apns-id': 'x' });
      stream.end(reply.reason === undefined ? undefined : JSON.stringify({ reason: reply.reason }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  received.length = 0;
  reply = { status: 200 };
});

const sender = (now = () => 1_790_000_000_000) =>
  createApnsSender(config, { origins: { sandbox: origin, production: `${origin}/unused` }, now });

function decodeJwt(token: string) {
  const [header, claims, signature] = token.split('.') as [string, string, string];
  const json = (part: string) =>
    JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
  const valid = verify(
    'sha256',
    Buffer.from(`${header}.${claims}`),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url'),
  );
  return { header: json(header), claims: json(claims), valid };
}

describe('encodeApnsAlert (M4-05, D5)', () => {
  it('shows a generic alert and carries only the metadata payload', () => {
    const body = JSON.parse(message.payload) as Record<string, unknown>;
    expect(body).toEqual({
      aps: {
        alert: { title: 'Approval needed on mac-studio', body: 'Tap to review.' },
        sound: 'default',
        category: 'rc.pending',
        'mutable-content': 1,
        'interruption-level': 'time-sensitive',
        'thread-id': 'agent-1',
      },
      rc: { t: 'pending', rid: RID, dev: 'mac-studio', exp: 1_790_000_000_000, sum: SUMMARY },
    });
    expect(Object.keys(body)).toEqual(['aps', 'rc']);
  });

  it('keeps the metadata under 200 bytes and the body within the APNs limit', () => {
    const maxSummary = 'A'.repeat(1368);
    const payload = encodeApnsAlert(
      encodePendingPayload(RID, 'm'.repeat(500), null, maxSummary),
      RID,
    );
    expect(new TextEncoder().encode(payload).length).toBeLessThanOrEqual(MAX_APNS_PAYLOAD_BYTES);
    const { rc } = JSON.parse(payload) as { rc: Record<string, unknown> };
    const { sum: _sum, ...metadata } = rc;
    expect(new TextEncoder().encode(JSON.stringify(metadata)).length).toBeLessThan(200);
  });

  it('uses a nameless title when the device name is empty', () => {
    const body = JSON.parse(encodeApnsAlert(encodePendingPayload(RID, '', null), 'a')) as {
      aps: { alert: { title: string } };
    };
    expect(body.aps.alert.title).toBe('Approval needed');
  });

  it('computes apns-expiration in epoch seconds', () => {
    expect(apnsExpiration(1_790_000_000_500, 120)).toBe(1_790_000_120);
  });
});

describe('apnsProviderToken', () => {
  it('signs an ES256 JWT with kid, iss and iat that verifies with the public key', () => {
    const jwt = decodeJwt(
      apnsProviderToken(parseApnsKey(pem), 'ABC123DEFG', 'TEAM123456', 1_790_000_000_999),
    );
    expect(jwt.valid).toBe(true);
    expect(jwt.header).toEqual({ alg: 'ES256', kid: 'ABC123DEFG' });
    expect(jwt.claims).toEqual({ iss: 'TEAM123456', iat: 1_790_000_000 });
  });

  it('accepts a PEM with escaped newlines and rejects a non-P-256 key', () => {
    expect(() => parseApnsKey(pem.replaceAll('\n', '\\n'))).not.toThrow();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    expect(() => parseApnsKey(rsa.export({ type: 'pkcs8', format: 'pem' }).toString())).toThrow(
      /EC P-256/,
    );
  });
});

describe('createApnsSender against a local HTTP/2 server (M4-05)', () => {
  it('posts the alert to /3/device/<token> with the APNs headers and provider token', async () => {
    const apns = sender();
    expect(await apns.send(target, message)).toEqual({ kind: 'sent' });
    apns.close();
    const [request] = received;
    expect(request?.headers).toMatchObject({
      ':method': 'POST',
      ':path': `/3/device/${target.token}`,
      'apns-topic': 'dev.example.app',
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': '1790000000',
      'apns-collapse-id': RID,
      'content-type': 'application/json',
    });
    const authorization = String(request?.headers.authorization);
    expect(authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(decodeJwt(authorization.slice('bearer '.length)).valid).toBe(true);
    expect(request?.body).toBe(message.payload);
  });

  it('reuses the provider token within 40 minutes and re-signs after', async () => {
    let now = 1_790_000_000_000;
    const apns = sender(() => now);
    await apns.send(target, message);
    now += 39 * 60_000;
    await apns.send(target, message);
    now += 2 * 60_000;
    await apns.send(target, message);
    apns.close();
    const [first, second, third] = received.map((r) => r.headers.authorization);
    expect(second).toBe(first);
    expect(third).not.toBe(first);
  });

  it('re-signs after APNs reports an expired provider token', async () => {
    const apns = sender();
    reply = { status: 403, reason: 'ExpiredProviderToken' };
    expect(await apns.send(target, message)).toEqual({ kind: 'failed', status: 403 });
    reply = { status: 200 };
    await apns.send(target, message);
    apns.close();
    expect(received).toHaveLength(2);
    expect(received[1]?.headers.authorization).not.toBe(received[0]?.headers.authorization);
  });

  it('maps 410 and dead-token reasons to gone and everything else to failed', async () => {
    const apns = sender();
    const cases: [typeof reply, unknown][] = [
      [{ status: 410, reason: 'Unregistered' }, { kind: 'gone' }],
      [{ status: 400, reason: 'BadDeviceToken' }, { kind: 'gone' }],
      [{ status: 400, reason: 'DeviceTokenNotForTopic' }, { kind: 'gone' }],
      [
        { status: 400, reason: 'PayloadTooLarge' },
        { kind: 'failed', status: 400 },
      ],
      [
        { status: 429, reason: 'TooManyRequests' },
        { kind: 'failed', status: 429 },
      ],
      [
        { status: 500, reason: 'InternalServerError' },
        { kind: 'failed', status: 500 },
      ],
    ];
    for (const [response, expected] of cases) {
      reply = response;
      expect(await apns.send(target, message)).toEqual(expected);
    }
    apns.close();
  });

  it('treats a non-hex token as gone without sending anything', async () => {
    const apns = sender();
    expect(await apns.send({ ...target, token: '../../evil' }, message)).toEqual({ kind: 'gone' });
    apns.close();
    expect(received).toHaveLength(0);
  });

  it('reports an unreachable server as failed without a status', async () => {
    const apns = createApnsSender(config, {
      origins: { sandbox: 'http://127.0.0.1:1', production: 'http://127.0.0.1:1' },
      timeoutMs: 2_000,
    });
    expect(await apns.send(target, message)).toEqual({ kind: 'failed', status: null });
    apns.close();
  });
});
