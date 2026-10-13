import { VERSION_TABLE } from '@remote-control/protocol';
import type { Frame } from '@remote-control/protocol';
import { describe, expect, it } from 'vitest';

import { createManualTimer } from '../test-timer.js';
import { fakeSockets } from './fake-socket.js';
import {
  BACKOFF_MAX_MS,
  CONNECT_TIMEOUT_MS,
  createRelaySocket,
  HEARTBEAT_MS,
  PONG_TIMEOUT_MS,
} from './relay-socket.js';
import type { SocketStatus } from './relay-socket.js';

const PHONE = '0d6f8a52-3c5e-4f0b-9a4e-111111111111';
const AGENT = '0d6f8a52-3c5e-4f0b-9a4e-222222222222';

function setup() {
  const timer = createManualTimer();
  const sockets = fakeSockets();
  const statuses: [SocketStatus, number][] = [];
  const frames: Frame[] = [];
  const opened: string[] = [];
  const socket = createRelaySocket({
    url: 'wss://rc.example.test/ws',
    createSocket: sockets.create,
    timer,
    version: '0.0.0-test',
    onOpen: (hello) => opened.push(hello.deviceId),
    onFrame: (frame) => frames.push(frame),
    onStatus: (status, failures) => statuses.push([status, failures]),
  });
  const connect = () => {
    sockets.last.open();
    sockets.last.helloOk(PHONE, timer.now());
  };
  return { timer, sockets, statuses, frames, opened, socket, connect };
}

describe('relay socket', () => {
  it('says hello, opens on hello_ok and passes frames on', () => {
    const t = setup();
    t.socket.start();
    t.socket.start();
    expect(t.sockets.all).toHaveLength(1);
    expect(t.socket.status).toBe('connecting');
    expect(t.socket.send({ v: VERSION_TABLE.v, kind: 'ack', ids: ['x'] })).toBe(false);
    t.sockets.last.open();
    expect(t.sockets.last.of('hello')[0]).toMatchObject({
      protocol: { min: 1, max: 1 },
      client: { kind: 'phone', version: '0.0.0-test' },
    });
    t.sockets.last.receive({ v: 1, kind: 'presence', deviceId: AGENT, online: true, at: 1 });
    expect(t.frames).toEqual([]);
    t.sockets.last.helloOk(PHONE, 5);
    expect(t.opened).toEqual([PHONE]);
    expect(t.socket.status).toBe('open');
    t.sockets.last.receive('not json');
    t.sockets.last.receive({ v: 1, kind: 'presence', deviceId: AGENT, online: true, at: 1 });
    expect(t.frames).toHaveLength(1);
    const ack: Frame = {
      v: VERSION_TABLE.v,
      kind: 'ack',
      ids: ['01a0f4c2-c400-7fff-bfff-ffffffffffff'],
    };
    expect(t.socket.send(ack)).toBe(true);
    expect(t.sockets.last.of('ack')).toEqual([ack]);
  });

  it('pings every 25 s and reconnects when a pong is late', () => {
    const t = setup();
    t.socket.start();
    t.connect();
    t.timer.advance(HEARTBEAT_MS);
    const ping = t.sockets.last.of('ping')[0]!;
    t.sockets.last.receive({ v: 1, kind: 'pong', t: ping.t, relayTs: ping.t });
    t.timer.advance(HEARTBEAT_MS);
    expect(t.sockets.last.of('ping')).toHaveLength(2);
    t.timer.advance(PONG_TIMEOUT_MS);
    expect(t.sockets.all[0]!.closed).toEqual({ code: 4000, reason: 'reconnect' });
    expect(t.socket.status).toBe('reconnecting');
    expect(t.statuses.at(-1)).toEqual(['reconnecting', 0]);
    t.timer.advance(1_000);
    expect(t.sockets.all).toHaveLength(2);
  });

  it('backs off 1 → 30 s and counts failures until hello_ok', () => {
    const t = setup();
    t.socket.start();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      const before = t.sockets.all.length;
      t.sockets.last.onclose?.({});
      let waited = 0;
      while (t.sockets.all.length === before) {
        t.timer.advance(500);
        waited += 500;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, BACKOFF_MAX_MS, BACKOFF_MAX_MS]);
    expect(t.statuses.at(-1)).toEqual(['reconnecting', 7]);
    t.connect();
    expect(t.statuses.at(-1)).toEqual(['open', 0]);
  });

  it('gives up on an attempt without hello_ok and on a socket error', () => {
    const t = setup();
    t.socket.start();
    t.sockets.last.open();
    t.timer.advance(CONNECT_TIMEOUT_MS);
    expect(t.statuses.at(-1)).toEqual(['reconnecting', 1]);
    t.timer.advance(1_000);
    t.sockets.last.onerror?.({});
    expect(t.statuses.at(-1)).toEqual(['reconnecting', 2]);
  });

  it('wakes: retries at once while backing off, probes an open socket', () => {
    const t = setup();
    t.socket.wake();
    t.socket.start();
    t.socket.wake();
    expect(t.sockets.all).toHaveLength(1);
    t.sockets.last.onclose?.({});
    t.socket.wake();
    expect(t.sockets.all).toHaveLength(2);
    t.connect();
    t.socket.wake();
    expect(t.sockets.last.of('ping')).toHaveLength(1);
    t.socket.wake();
    expect(t.sockets.last.of('ping')).toHaveLength(1);
    t.timer.advance(PONG_TIMEOUT_MS);
    expect(t.socket.status).toBe('reconnecting');
  });

  it('stops for good', () => {
    const t = setup();
    t.socket.stop();
    t.socket.start();
    t.connect();
    t.socket.stop();
    expect(t.sockets.last.closed).toEqual({ code: 1000, reason: 'bye' });
    expect(t.socket.status).toBe('stopped');
    expect(t.timer.pending).toBe(0);
    t.socket.start();
    t.socket.stop();
    t.sockets.last.onclose?.({});
    expect(t.timer.pending).toBe(0);
  });
});
