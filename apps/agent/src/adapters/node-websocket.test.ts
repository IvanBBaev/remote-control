import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import type { WebSocketHandlers } from '../ports/web-socket.js';
import { nodeWebSocket } from './node-websocket.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

async function acceptKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(key + GUID));
  return Buffer.from(digest).toString('base64');
}

/** One unmasked server frame (payloads under 126 bytes). */
function frame(opcode: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}

/** Reads masked client frames (payloads under 126 bytes) from a growing buffer. */
function readFrames(buffer: Buffer): {
  frames: { opcode: number; payload: Buffer }[];
  rest: Buffer;
} {
  const frames: { opcode: number; payload: Buffer }[] = [];
  let offset = 0;
  while (buffer.length - offset >= 6) {
    const opcode = (buffer[offset] as number) & 0x0f;
    const length = (buffer[offset + 1] as number) & 0x7f;
    if (buffer.length - offset < 6 + length) break;
    const mask = buffer.subarray(offset + 2, offset + 6);
    const payload = Buffer.alloc(length);
    for (let i = 0; i < length; i++) {
      payload[i] = (buffer[offset + 6 + i] as number) ^ (mask[i % 4] as number);
    }
    frames.push({ opcode, payload });
    offset += 6 + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

/** A minimal WebSocket server: records the auth header, sends a binary and a text frame, echoes text. */
async function startServer(
  refuse = false,
): Promise<{ server: Server; url: string; auth: string[] }> {
  const auth: string[] = [];
  const server = createServer();
  server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
    auth.push(request.headers.authorization ?? '');
    if (refuse) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    void acceptKey(request.headers['sec-websocket-key'] ?? '').then((accept) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.write(frame(0x2, Buffer.from([1, 2, 3])));
      socket.write(frame(0x1, Buffer.from('welcome')));
      let pending: Buffer = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        const { frames, rest } = readFrames(Buffer.concat([pending, chunk]));
        pending = rest;
        for (const { opcode, payload } of frames) {
          if (opcode === 0x1) socket.write(frame(0x1, Buffer.from(`echo:${payload.toString()}`)));
          if (opcode === 0x8) {
            socket.write(frame(0x8, payload));
            socket.end();
          }
        }
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `ws://127.0.0.1:${port}/ws`, auth };
}

function recorder() {
  const events: string[] = [];
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
  let onText: ((text: string) => void) | undefined;
  const handlers: WebSocketHandlers = {
    onOpen: () => events.push('open'),
    onMessage: (text) => {
      events.push(`message:${text}`);
      onText?.(text);
    },
    onClose: (code, reason) => {
      events.push(`close:${code}:${reason}`);
      resolveClosed();
    },
  };
  return {
    events,
    handlers,
    closed,
    next: () => new Promise<string>((resolve) => (onText = resolve)),
  };
}

describe('nodeWebSocket', () => {
  let server: Server | undefined;
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it('sends the headers, delivers text, ignores binary and closes once', async () => {
    const started = await startServer();
    server = started.server;
    const rec = recorder();
    const welcome = rec.next();
    const connection = nodeWebSocket(started.url, { authorization: 'Bearer t' }, rec.handlers);
    expect(await welcome).toBe('welcome');
    const echo = rec.next();
    connection.send('hi');
    expect(await echo).toBe('echo:hi');
    connection.close(4000, 'done');
    await rec.closed;
    connection.close();
    expect(started.auth).toEqual(['Bearer t']);
    expect(rec.events).toEqual(['open', 'message:welcome', 'message:echo:hi', 'close:4000:done']);
  });

  it('falls back to a plain close for a code a client may not send', async () => {
    const started = await startServer();
    server = started.server;
    const rec = recorder();
    const welcome = rec.next();
    const connection = nodeWebSocket(started.url, {}, rec.handlers);
    await welcome;
    connection.close(1012, 'restart');
    await rec.closed;
    expect(rec.events.at(-1)).toMatch(/^close:/);
  });

  it('reports a refused upgrade as a close and drops sends before open', async () => {
    const started = await startServer(true);
    server = started.server;
    const rec = recorder();
    const connection = nodeWebSocket(started.url, {}, rec.handlers);
    connection.send('lost');
    await rec.closed;
    expect(rec.events).toEqual(['close:1006:']);
  });
});
