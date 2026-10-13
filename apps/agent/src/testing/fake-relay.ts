import {
  encodeFrame,
  parseFrame,
  VERSION_TABLE,
  type Envelope,
  type Frame,
  type RelayErrorCode,
} from '@remote-control/protocol';

import type { FetchFn } from '../adapters/npm-registry.js';
import type { Clock } from '../ports/clock.js';
import type {
  WebSocketConnection,
  WebSocketFactory,
  WebSocketHandlers,
} from '../ports/web-socket.js';

/** The account every fake device belongs to. */
export const FAKE_USER_ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
export const FAKE_RELAY_ORIGIN = 'http://127.0.0.1:8787';
const SLOT_TTL_MS = 5 * 60_000;
const MAX_FAILED_ATTEMPTS = 3;

export interface FakeDevice {
  readonly id: string;
  readonly kind: 'agent' | 'phone';
  readonly name: string;
  readonly token: string;
}

interface Socket {
  readonly device: FakeDevice;
  readonly handlers: WebSocketHandlers;
  hello: boolean;
  open: boolean;
}

interface Slot {
  readonly id: string;
  readonly agentId: string;
  readonly codeHash: string;
  readonly expiresAt: number;
  state: 'open' | 'joined' | 'closed';
  phoneDeviceId: string | null;
  failedAttempts: number;
  completed: boolean;
}

export interface FakeRelay {
  readonly userId: string;
  readonly agent: FakeDevice;
  addPhone(name: string): FakeDevice;
  /** Connects devices by bearer token; the URL is ignored. */
  readonly webSocket: WebSocketFactory;
  /** The pairing API (`/api/pairings…`), as the agent and the phones call it. */
  readonly fetch: FetchFn;
  /** Decision hashes with a verified passkey assertion (M0-11). */
  readonly verified: Set<string>;
  /** Envelopes for an offline device (the relay's pending sink, Web Push trigger). */
  readonly undelivered: Envelope[];
  /** Every envelope the relay routed, in order: what the relay can see (I3 checks). */
  readonly routed: Envelope[];
  /** Error frames sent to devices. */
  readonly errors: { readonly deviceId: string; readonly code: RelayErrorCode }[];
  /** Holds `hello_ok` back (for timeout tests). */
  silent: boolean;
  /** Closes a device's socket from the relay side. */
  disconnect(deviceId: string, code?: number): void;
  online(deviceId: string): boolean;
  /** Connection attempts per device id. */
  attempts(deviceId: string): number;
}

/**
 * An in-process relay for agent tests: the M0-06/M0-09/M0-10 routing rules on fake
 * sockets, without HTTP or timers. Delivery is asynchronous (microtasks), like a network.
 */
export function createFakeRelay(clock: Clock): FakeRelay {
  let next = 0;
  const byToken = new Map<string, FakeDevice>();
  const sockets = new Map<string, Socket>();
  const attempts = new Map<string, number>();
  const slots = new Map<string, Slot>();
  const ackRoutes = new Map<string, string>();

  function device(kind: FakeDevice['kind'], name: string): FakeDevice {
    next += 1;
    const n = next.toString(16).padStart(8, '0');
    const created = { id: `${n}-0000-4000-8000-000000000000`, kind, name, token: `token-${n}` };
    byToken.set(created.token, created);
    return created;
  }

  const agent = device('agent', 'agent');

  function later(run: () => void): void {
    queueMicrotask(run);
  }

  function deliver(socket: Socket, frame: Frame): void {
    later(() => {
      if (socket.open) socket.handlers.onMessage(encodeFrame(frame));
    });
  }

  function close(socket: Socket, code: number, reason: string): void {
    if (!socket.open) return;
    socket.open = false;
    if (sockets.get(socket.device.id) === socket) {
      sockets.delete(socket.device.id);
      broadcastPresence(socket.device, false);
    }
    later(() => socket.handlers.onClose(code, reason));
  }

  function broadcastPresence(changed: FakeDevice, online: boolean): void {
    for (const other of sockets.values()) {
      if (other.device.id === changed.id || !other.hello) continue;
      deliver(other, {
        v: VERSION_TABLE.v,
        kind: 'presence',
        deviceId: changed.id,
        online,
        at: clock.now(),
      });
    }
  }

  function error(socket: Socket, code: RelayErrorCode, ref: string | null): void {
    relay.errors.push({ deviceId: socket.device.id, code });
    deliver(socket, { v: VERSION_TABLE.v, kind: 'error', code, ref, message: code });
  }

  function hello(socket: Socket, frame: Frame): void {
    if (frame.kind !== 'hello') return close(socket, 1008, 'hello expected');
    if (frame.protocol.min > VERSION_TABLE.v || frame.protocol.max < VERSION_TABLE.v) {
      return close(socket, 4001, 'unsupported version');
    }
    if (relay.silent) return;
    const previous = sockets.get(socket.device.id);
    if (previous !== undefined) {
      sockets.delete(socket.device.id);
      close(previous, 4000, 'superseded');
    }
    socket.hello = true;
    sockets.set(socket.device.id, socket);
    deliver(socket, {
      v: VERSION_TABLE.v,
      kind: 'hello_ok',
      protocol: VERSION_TABLE.v,
      min_supported: VERSION_TABLE.min_supported,
      deviceId: socket.device.id,
      relayTs: clock.now(),
      presence: [...byToken.values()]
        .filter((other) => other.id !== socket.device.id)
        .map((other) => ({
          deviceId: other.id,
          kind: other.kind,
          name: other.name,
          online: sockets.has(other.id),
          lastSeen: null,
        })),
    });
    if (previous === undefined) broadcastPresence(socket.device, true);
  }

  function route(socket: Socket, envelope: Envelope): void {
    if (envelope.from !== socket.device.id || envelope.to === socket.device.id) {
      return error(socket, 'bad_frame', envelope.id);
    }
    if (envelope.expiresAt !== null && envelope.expiresAt <= clock.now()) {
      return error(socket, 'expired', envelope.id);
    }
    if (
      envelope.cls === 'command' &&
      envelope.decisionHash !== undefined &&
      !relay.verified.has(envelope.decisionHash)
    ) {
      return error(socket, 'unverified', envelope.id);
    }
    relay.routed.push(envelope);
    ackRoutes.set(envelope.id, socket.device.id);
    const targets =
      envelope.to === null
        ? [...byToken.values()].filter((other) => other.id !== socket.device.id)
        : [...byToken.values()].filter((other) => other.id === envelope.to);
    for (const target of targets) {
      const live = sockets.get(target.id);
      if (live === undefined) relay.undelivered.push(envelope);
      else deliver(live, envelope);
    }
  }

  function receive(socket: Socket, text: string): void {
    if (!socket.open) return;
    const parsed = parseFrame(text);
    if (!parsed.ok) return close(socket, 1008, 'bad frame');
    const frame = parsed.frame;
    if (!socket.hello) return hello(socket, frame);
    switch (frame.kind) {
      case 'data':
        return route(socket, frame);
      case 'ack':
        for (const id of frame.ids) {
          const sender = sockets.get(ackRoutes.get(id) ?? '');
          if (sender !== undefined) deliver(sender, frame);
        }
        return;
      case 'ping':
        return deliver(socket, {
          v: VERSION_TABLE.v,
          kind: 'pong',
          t: frame.t,
          relayTs: clock.now(),
        });
      default:
        return close(socket, 1008, 'unexpected frame');
    }
  }

  const webSocket: WebSocketFactory = (_url, headers, handlers) => {
    const token = (headers['authorization'] ?? '').replace(/^Bearer /, '');
    const owner = byToken.get(token);
    const socket: Socket | undefined =
      owner === undefined ? undefined : { device: owner, handlers, hello: false, open: true };
    if (owner !== undefined) attempts.set(owner.id, (attempts.get(owner.id) ?? 0) + 1);
    later(() => {
      if (socket === undefined) handlers.onClose(1006, '');
      else if (socket.open) handlers.onOpen();
    });
    const connection: WebSocketConnection = {
      send: (text) => {
        if (socket !== undefined) later(() => receive(socket, text));
      },
      close: (code = 1005, reason = '') => {
        if (socket !== undefined) close(socket, code, reason);
      },
    };
    return connection;
  };

  function json(status: number, body: unknown): Response {
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  }

  function slotView(slot: Slot) {
    const expired = slot.state !== 'closed' && clock.now() >= slot.expiresAt;
    return {
      slotId: slot.id,
      state: expired ? 'expired' : slot.state,
      phoneDeviceId: slot.phoneDeviceId,
      failedAttempts: slot.failedAttempts,
      expiresAt: slot.expiresAt,
    };
  }

  const fetch: FetchFn = (url, init) => {
    const caller = byToken.get(
      String((init.headers as Record<string, string>)['authorization']).replace(/^Bearer /, ''),
    );
    const path = new URL(url).pathname;
    const body = init.body === undefined ? {} : (JSON.parse(init.body as string) as never);
    const method = init.method ?? 'GET';
    if (caller === undefined) return Promise.resolve(json(401, { error: 'unauthorized' }));
    if (method === 'POST' && path === '/api/agents/token' && caller.kind === 'agent') {
      // Rotation: the presented token stops working, the new one maps to the same device.
      byToken.delete(String((init.headers as Record<string, string>)['authorization']).slice(7));
      next += 1;
      const token = `token-rotated-${next}`;
      byToken.set(token, caller);
      return Promise.resolve(json(200, { token }));
    }
    if (method === 'POST' && path === '/api/pairings/join') {
      const { codeHash } = body as { codeHash: string };
      const slot = [...slots.values()].find(
        (candidate) =>
          candidate.codeHash === codeHash &&
          candidate.state === 'open' &&
          clock.now() < candidate.expiresAt,
      );
      if (slot === undefined) return Promise.resolve(json(404, { error: 'not_found' }));
      slot.state = 'joined';
      slot.phoneDeviceId = caller.id;
      return Promise.resolve(
        json(200, { slotId: slot.id, agentDeviceId: slot.agentId, expiresAt: slot.expiresAt }),
      );
    }
    if (method === 'POST' && path === '/api/pairings') {
      const { codeHash } = body as { codeHash: string };
      if ([...slots.values()].some((s) => s.codeHash === codeHash && s.state !== 'closed')) {
        return Promise.resolve(json(409, { error: 'code_in_use' }));
      }
      next += 1;
      const id = `${next.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
      const slot: Slot = {
        id,
        agentId: caller.id,
        codeHash,
        expiresAt: clock.now() + SLOT_TTL_MS,
        state: 'open',
        phoneDeviceId: null,
        failedAttempts: 0,
        completed: false,
      };
      slots.set(id, slot);
      return Promise.resolve(json(201, { slotId: id, expiresAt: slot.expiresAt }));
    }
    const match = /^\/api\/pairings\/([^/]+)(?:\/(complete|fail))?$/.exec(path);
    const slot = match === null ? undefined : slots.get(match[1]!);
    if (match === null || slot === undefined || slot.agentId !== caller.id) {
      return Promise.resolve(json(404, { error: 'not_found' }));
    }
    const action = match[2];
    if (method === 'GET') return Promise.resolve(json(200, slotView(slot)));
    if (method === 'DELETE') {
      slot.state = 'closed';
      return Promise.resolve(json(204, null));
    }
    if (action === 'complete') {
      if (slot.state !== 'joined') return Promise.resolve(json(409, { error: 'not_joined' }));
      slot.state = 'closed';
      slot.completed = true;
      return Promise.resolve(
        json(200, { pairingId: `pairing-${slot.id}`, phoneDeviceId: slot.phoneDeviceId }),
      );
    }
    slot.failedAttempts += 1;
    slot.phoneDeviceId = null;
    slot.state = slot.failedAttempts >= MAX_FAILED_ATTEMPTS ? 'closed' : 'open';
    return Promise.resolve(json(200, { state: slot.state, failedAttempts: slot.failedAttempts }));
  };

  const relay: FakeRelay = {
    userId: FAKE_USER_ID,
    agent,
    addPhone: (name) => device('phone', name),
    webSocket,
    fetch,
    verified: new Set(),
    undelivered: [],
    routed: [],
    errors: [],
    silent: false,
    disconnect(deviceId, code = 1012) {
      const socket = sockets.get(deviceId);
      if (socket !== undefined) close(socket, code, 'relay closed');
    },
    online: (deviceId) => sockets.has(deviceId),
    attempts: (deviceId) => attempts.get(deviceId) ?? 0,
  };
  return relay;
}
