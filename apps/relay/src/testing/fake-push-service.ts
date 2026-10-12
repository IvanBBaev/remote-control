import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { PushTarget } from '../ports/push.js';

/** What the fake push service saw in one POST. */
export interface ReceivedPush {
  /** The subscription the message was addressed to. */
  readonly endpoint: string;
  readonly headers: {
    readonly authorization: string | undefined;
    readonly ttl: string | undefined;
    readonly urgency: string | undefined;
    readonly topic: string | undefined;
    readonly contentEncoding: string | undefined;
  };
  /** The encrypted body as it went over the wire. */
  readonly body: Uint8Array;
  /** The decrypted payload, or `null` when the message was rejected. */
  readonly plaintext: string | null;
  /** The verified VAPID JWT claims, or `null` when the message was rejected. */
  readonly claims: Record<string, unknown> | null;
  /** Why the service answered 400, or `null` when it accepted the message. */
  readonly rejected: string | null;
}

const subtle = globalThis.crypto.subtle;
type Key = Awaited<ReturnType<typeof subtle.importKey>>;

interface Subscriber {
  readonly privateKey: Key;
  readonly publicKey: Uint8Array;
  readonly auth: Uint8Array;
  status: number;
}

const encoder = new TextEncoder();
const URGENCIES = new Set(['very-low', 'low', 'normal', 'high']);

const fromB64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64url'));
const toB64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const concat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));
const header = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8),
  );
}

function readBody(request: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    request.on('error', reject);
  });
}

/**
 * A local RFC 8030 push service for relay tests (07 W19): it accepts a message only with
 * a valid VAPID `Authorization` (RFC 8292, ES256 signature checked against the expected
 * key), `TTL`, `Urgency` and an aes128gcm body (RFC 8188/8291) that it decrypts with the
 * subscriber's keys, and that does not contain the plaintext. Anything else is a 400
 * with the reason recorded in {@link received}.
 */
export class FakePushService {
  readonly received: ReceivedPush[] = [];
  readonly #subscribers = new Map<string, Subscriber>();
  #next = 0;

  private constructor(
    private readonly server: Server,
    readonly origin: string,
    private readonly vapidPublicKey: string,
  ) {}

  /** Listens on 127.0.0.1, port 0; messages must be signed by `vapidPublicKey`'s key. */
  static async start(vapidPublicKey: string): Promise<FakePushService> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const service = new FakePushService(server, `http://127.0.0.1:${port}`, vapidPublicKey);
    server.on('request', (request: IncomingMessage, response: ServerResponse) => {
      void service.#handle(request).then(
        (status) => response.writeHead(status).end(),
        () => response.writeHead(500).end(),
      );
    });
    return service;
  }

  /** A new browser subscription: fresh P-256 key pair and auth secret. */
  async subscribe(): Promise<PushTarget> {
    const pair = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ])) as { readonly privateKey: Key; readonly publicKey: Key };
    const publicKey = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
    const auth = new Uint8Array(16).map((_, index) => (index * 37 + this.#next) & 0xff);
    const endpoint = `${this.origin}/push/${String(this.#next++)}`;
    this.#subscribers.set(endpoint, { privateKey: pair.privateKey, publicKey, auth, status: 201 });
    return { endpoint, p256dh: toB64(publicKey), auth: toB64(auth) };
  }

  /** Answers every later message to `endpoint` with `status` (e.g. 410 Gone, 429). */
  respondWith(endpoint: string, status: number): void {
    const subscriber = this.#subscribers.get(endpoint);
    if (subscriber !== undefined) subscriber.status = status;
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  async #handle(request: IncomingMessage): Promise<number> {
    const endpoint = `${this.origin}${request.url ?? ''}`;
    const subscriber = this.#subscribers.get(endpoint);
    const body = await readBody(request);
    const headers = {
      authorization: header(request.headers.authorization),
      ttl: header(request.headers.ttl),
      urgency: header(request.headers.urgency),
      topic: header(request.headers.topic),
      contentEncoding: header(request.headers['content-encoding']),
    };
    if (subscriber === undefined) return 404;
    const verdict = await this.#verify(request.method, headers, subscriber, body).then(
      (accepted) => ({ ...accepted, rejected: null }),
      (error: unknown) => ({ plaintext: null, claims: null, rejected: (error as Error).message }),
    );
    const { plaintext, claims, rejected } = verdict;
    this.received.push({ endpoint, headers, body, plaintext, claims, rejected });
    return rejected === null ? subscriber.status : 400;
  }

  async #verify(
    method: string | undefined,
    headers: ReceivedPush['headers'],
    subscriber: Subscriber,
    body: Uint8Array,
  ): Promise<{ plaintext: string; claims: Record<string, unknown> }> {
    if (method !== 'POST') throw new Error('method');
    const claims = await this.#verifyVapid(headers.authorization);
    if (headers.ttl === undefined || !/^\d+$/.test(headers.ttl)) throw new Error('ttl');
    if (headers.urgency === undefined || !URGENCIES.has(headers.urgency)) {
      throw new Error('urgency');
    }
    if (headers.contentEncoding !== 'aes128gcm') throw new Error('content-encoding');
    const plaintext = await decrypt(subscriber, body);
    if (Buffer.from(body).includes(Buffer.from(plaintext))) throw new Error('plaintext body');
    return { plaintext, claims };
  }

  /** RFC 8292: `vapid t=<ES256 JWT>, k=<public key>` with `aud` = this service's origin. */
  async #verifyVapid(authorization: string | undefined): Promise<Record<string, unknown>> {
    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(authorization ?? '');
    if (match === null) throw new Error('authorization');
    const [, head, body, signature, key] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (key !== this.vapidPublicKey) throw new Error('vapid key');
    const jwtHeader = JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) as unknown;
    if ((jwtHeader as { alg?: unknown }).alg !== 'ES256') throw new Error('jwt alg');
    const verifier = await subtle.importKey(
      'raw',
      fromB64(key),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const valid = await subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifier,
      fromB64(signature),
      encoder.encode(`${head}.${body}`),
    );
    if (!valid) throw new Error('jwt signature');
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (claims.aud !== this.origin) throw new Error('jwt aud');
    if (typeof claims.exp !== 'number') throw new Error('jwt exp');
    if (typeof claims.sub !== 'string' || !/^(mailto|https):/.test(claims.sub)) {
      throw new Error('jwt sub');
    }
    return claims;
  }
}

/** RFC 8291 §3.4 / RFC 8188 §2: decrypts a single-record aes128gcm body. */
async function decrypt(subscriber: Subscriber, body: Uint8Array): Promise<string> {
  const salt = body.subarray(0, 16);
  const idLength = body[20] ?? 0;
  const senderKey = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);
  const senderPublic = await subtle.importKey(
    'raw',
    senderKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const secret = new Uint8Array(
    await subtle.deriveBits({ name: 'ECDH', public: senderPublic }, subscriber.privateKey, 256),
  );
  const keyInfo = concat(encoder.encode('WebPush: info\0'), subscriber.publicKey, senderKey);
  const ikm = await hkdf(subscriber.auth, secret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);
  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const padded = new Uint8Array(
    await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext),
  );
  // The last record ends with the 0x02 delimiter, then optional zero padding.
  const end = padded.lastIndexOf(2);
  if (end === -1) throw new Error('padding');
  return new TextDecoder('utf-8', { fatal: true }).decode(padded.subarray(0, end));
}
