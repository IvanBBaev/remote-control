import { encodeFrame, type Frame } from '@remote-control/protocol';
import { describe, expect, it } from 'vitest';

import type { Random } from '../ports/random.js';
import type { WebSocketHandlers } from '../ports/web-socket.js';
import { manualTime } from '../testing/manual-time.js';
import {
  BACKOFF_MAX_MS,
  HELLO_OK_TIMEOUT_MS,
  HOLD_RETRY_MS,
  backoffDelay,
  createRelayClient,
  type RelayClientOptions,
} from './relay-client.js';

const fixed = (byte: number): Random => ({ bytes: (n) => new Uint8Array(n).fill(byte) });

const AGENT = '00000001-0000-4000-8000-000000000000';
const PHONE = '00000002-0000-4000-8000-000000000000';

const HELLO_OK: Frame = {
  v: 1,
  kind: 'hello_ok',
  protocol: 1,
  min_supported: 1,
  deviceId: AGENT,
  relayTs: 1,
  presence: [],
};

const DATA: Frame = {
  v: 1,
  kind: 'data',
  id: '01890000-0000-7000-8000-000000000001',
  from: PHONE,
  to: AGENT,
  session: null,
  cls: 'control',
  seq: 0,
  ts: 1,
  expiresAt: null,
  payload: 'AQ==',
};

interface Scripted {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly handlers: WebSocketHandlers;
  readonly sent: Frame[];
  closed?: { code: number | undefined; reason: string | undefined };
}

function setup(overrides: Partial<RelayClientOptions> = {}) {
  const time = manualTime();
  const sockets: Scripted[] = [];
  const events: string[] = [];
  const client = createRelayClient({
    url: 'wss://relay.example/ws',
    token: 'tok',
    version: '1.2.3',
    timer: time.timer,
    random: fixed(0),
    webSocket(url, headers, handlers) {
      const socket: Scripted = { url, headers, handlers, sent: [] };
      sockets.push(socket);
      return {
        send: (text) => socket.sent.push(JSON.parse(text) as Frame),
        close: (code, reason) => (socket.closed = { code, reason }),
      };
    },
    onReady: (helloOk) => events.push(`ready ${helloOk.deviceId}`),
    onEnvelope: (envelope) => events.push(`envelope ${envelope.id}`),
    onPresence: (presence) => events.push(`presence ${presence.online}`),
    onRelayError: (error) => events.push(`error ${error.code}`),
    onDown: (code) => events.push(`down ${code}`),
    onRetry: (code, _reason, delay) => events.push(`retry ${code} ${delay}`),
    ...overrides,
  });
  const last = () => sockets.at(-1)!;
  const deliver = (frame: Frame) => last().handlers.onMessage(encodeFrame(frame));
  return { time, sockets, events, client, last, deliver };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('backoffDelay', () => {
  it('stays within [ceiling / 2, ceiling], doubling from 1 s to 60 s', () => {
    expect(backoffDelay(0, fixed(0))).toBe(500);
    expect(backoffDelay(0, fixed(255))).toBe(1_000);
    expect(backoffDelay(3, fixed(0))).toBe(4_000);
    expect(backoffDelay(6, fixed(255))).toBe(BACKOFF_MAX_MS);
    expect(backoffDelay(1_000, fixed(0))).toBe(BACKOFF_MAX_MS / 2);
    expect(backoffDelay(1_000, fixed(255))).toBeLessThanOrEqual(BACKOFF_MAX_MS);
  });
});

describe('createRelayClient', () => {
  it('connects with the bearer token and sends hello with the protocol and package version', async () => {
    const t = setup();
    t.client.start();
    t.client.start();
    await flush();
    expect(t.sockets).toHaveLength(1);
    expect(t.last().url).toBe('wss://relay.example/ws');
    expect(t.last().headers).toEqual({ authorization: 'Bearer tok' });
    t.last().handlers.onOpen();
    expect(t.last().sent).toEqual([
      {
        v: 1,
        kind: 'hello',
        protocol: { min: 1, max: 1 },
        client: { kind: 'agent', version: '1.2.3' },
      },
    ]);
    expect(t.client.ready).toBe(false);
    expect(t.client.send(DATA)).toBe(false);
  });

  it('ignores frames before hello_ok, then acks and forwards data', async () => {
    const t = setup();
    t.client.start();
    await flush();
    t.last().handlers.onOpen();
    t.last().handlers.onMessage('not json');
    t.deliver(DATA);
    expect(t.events).toEqual([]);
    t.deliver(HELLO_OK);
    expect(t.client.ready).toBe(true);
    t.deliver(DATA);
    t.deliver({ v: 1, kind: 'presence', deviceId: PHONE, online: true, at: 1 });
    t.deliver({ v: 1, kind: 'error', code: 'expired', ref: null, message: 'x' });
    t.deliver({ v: 1, kind: 'pong', t: 1, relayTs: 2 });
    expect(t.events).toEqual([
      `ready ${AGENT}`,
      `envelope ${DATA.id}`,
      'presence true',
      'error expired',
    ]);
    expect(t.last().sent.at(-1)).toEqual({ v: 1, kind: 'ack', ids: [DATA.id] });
    expect(t.client.send(DATA)).toBe(true);
    expect(t.last().sent.at(-1)).toEqual(DATA);
    // No hello_ok timeout once ready.
    t.time.advance(HELLO_OK_TIMEOUT_MS);
    expect(t.last().closed).toBeUndefined();
  });

  it('never gives up: reconnects with growing jittered backoff and resets it on hello_ok', async () => {
    const t = setup();
    t.client.start();
    await flush();
    for (let i = 0; i < 8; i++) {
      t.last().handlers.onClose(1006, '');
      t.time.advance(BACKOFF_MAX_MS);
      await flush();
    }
    expect(t.sockets).toHaveLength(9);
    expect(t.events).toEqual([
      'retry 1006 500',
      'retry 1006 1000',
      'retry 1006 2000',
      'retry 1006 4000',
      'retry 1006 8000',
      'retry 1006 16000',
      'retry 1006 30000',
      'retry 1006 30000',
    ]);
    t.last().handlers.onOpen();
    t.deliver(HELLO_OK);
    t.last().handlers.onClose(1012, 'restart');
    expect(t.client.ready).toBe(false);
    expect(t.events.slice(-3)).toEqual([`ready ${AGENT}`, 'down 1012', 'retry 1012 500']);
    // Messages on a closed socket are ignored.
    t.deliver(DATA);
    expect(t.events.at(-1)).toBe('retry 1012 500');
    t.time.advance(499);
    await flush();
    expect(t.sockets).toHaveLength(9);
    t.time.advance(1);
    await flush();
    expect(t.sockets).toHaveLength(10);
  });

  it('drops a socket that gets no hello_ok in time', async () => {
    const t = setup();
    t.client.start();
    await flush();
    t.last().handlers.onOpen();
    t.time.advance(HELLO_OK_TIMEOUT_MS - 1);
    expect(t.last().closed).toBeUndefined();
    t.time.advance(1);
    expect(t.last().closed).toEqual({ code: 1000, reason: 'no hello_ok' });
  });

  it('holds connect attempts while canConnect says no', async () => {
    let allowed = false;
    const t = setup({ canConnect: () => Promise.resolve(allowed) });
    t.client.start();
    await flush();
    expect(t.sockets).toHaveLength(0);
    t.time.advance(HOLD_RETRY_MS);
    await flush();
    expect(t.sockets).toHaveLength(0);
    allowed = true;
    t.time.advance(HOLD_RETRY_MS);
    await flush();
    expect(t.sockets).toHaveLength(1);
  });

  it('stops for good: closes the socket, cancels timers and never reconnects', async () => {
    const t = setup();
    t.client.start();
    await flush();
    t.last().handlers.onOpen();
    t.deliver(HELLO_OK);
    t.client.stop();
    expect(t.last().closed).toEqual({ code: 1000, reason: 'agent stopping' });
    expect(t.client.ready).toBe(false);
    t.last().handlers.onClose(1000, 'agent stopping');
    t.time.advance(BACKOFF_MAX_MS);
    await flush();
    expect(t.sockets).toHaveLength(1);
    expect(t.time.active()).toBe(0);
    expect(t.events).not.toContain('down 1000');
  });

  it('does not connect when stopped during a held attempt', async () => {
    let release: (value: boolean) => void = () => undefined;
    const t = setup({ canConnect: () => new Promise((resolve) => (release = resolve)) });
    t.client.start();
    await flush();
    t.client.stop();
    release(true);
    await flush();
    expect(t.sockets).toHaveLength(0);

    const held = setup({ canConnect: () => new Promise((resolve) => (release = resolve)) });
    held.client.start();
    await flush();
    held.client.stop();
    release(false);
    await flush();
    expect(held.time.active()).toBe(0);
    held.client.stop();
  });

  it('forwards peer_revoked and stops for good on close 4002 (M1-10)', async () => {
    const t = setup({
      onPeerRevoked: (deviceId) => t.events.push(`peer_revoked ${deviceId}`),
      onRevoked: (reason) => t.events.push(`revoked ${reason}`),
    });
    t.client.start();
    await flush();
    t.last().handlers.onOpen();
    t.deliver(HELLO_OK);
    t.deliver({ v: 1, kind: 'peer_revoked', deviceId: PHONE });
    t.last().handlers.onClose(4002, 'account_deleted');
    expect(t.events).toEqual([
      `ready ${AGENT}`,
      `peer_revoked ${PHONE}`,
      'down 4002',
      'revoked account_deleted',
    ]);
    expect(t.client.ready).toBe(false);
    t.time.advance(BACKOFF_MAX_MS);
    await flush();
    expect(t.sockets).toHaveLength(1);
    expect(t.time.active()).toBe(0);
  });

  it('asks isRevoked after a failed attempt and stops when the token is gone', async () => {
    let gone: boolean | Error = false;
    const asked: number[] = [];
    const t = setup({
      isRevoked: () => {
        asked.push(t.sockets.length);
        return gone instanceof Error ? Promise.reject(gone) : Promise.resolve(gone);
      },
      onRevoked: (reason) => t.events.push(`revoked ${reason}`),
    });
    t.client.start();
    await flush();
    t.last().handlers.onClose(1006, '');
    await flush();
    expect(t.events).toEqual(['retry 1006 500']);
    gone = new Error('offline');
    t.time.advance(500);
    await flush();
    t.last().handlers.onClose(1006, '');
    await flush();
    expect(t.events.at(-1)).toBe('retry 1006 1000');
    gone = true;
    t.time.advance(1_000);
    await flush();
    t.last().handlers.onClose(1006, '');
    await flush();
    expect(t.events.at(-1)).toBe('revoked revoked');
    expect(asked).toEqual([1, 2, 3]);
    t.time.advance(BACKOFF_MAX_MS);
    await flush();
    expect(t.sockets).toHaveLength(3);
    // A drop after hello_ok is a plain outage: no isRevoked call.
    const ready = setup({ isRevoked: () => Promise.resolve(true) });
    ready.client.start();
    await flush();
    ready.last().handlers.onOpen();
    ready.deliver(HELLO_OK);
    ready.last().handlers.onClose(1006, '');
    expect(ready.events.at(-1)).toBe('retry 1006 500');
  });
});
