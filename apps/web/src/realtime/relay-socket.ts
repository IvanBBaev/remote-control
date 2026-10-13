import { encodeFrame, parseFrame, VERSION_TABLE } from '@remote-control/protocol';
import type { Frame, HelloOk } from '@remote-control/protocol';

import type { Timer, TimerHandle } from '../ports/timer.js';

/** What the client needs of a WebSocket: the browser's and the `ws` package's both fit. */
export interface SocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string) => SocketLike;

/** Rec-5 timings (05-pwa). */
export const HEARTBEAT_MS = 25_000;
export const PONG_TIMEOUT_MS = 10_000;
export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
/** Without `hello_ok` by then the attempt counts as failed. */
export const CONNECT_TIMEOUT_MS = 10_000;

export type SocketStatus = 'connecting' | 'open' | 'reconnecting' | 'stopped';

export interface RelaySocketEvents {
  /** The relay accepted `hello`: the socket is usable. */
  onOpen(hello: HelloOk): void;
  /** Every frame after `hello_ok` (data, ack, presence, pong, error). */
  onFrame(frame: Exclude<Frame, HelloOk>): void;
  /** Status changes; `failures` counts consecutive attempts that never reached `hello_ok`. */
  onStatus(status: SocketStatus, failures: number): void;
}

export interface RelaySocketOptions extends RelaySocketEvents {
  readonly url: string;
  readonly createSocket: SocketFactory;
  readonly timer: Timer;
  /** The PWA build version, sent in `hello`. */
  readonly version: string;
}

export interface RelaySocket {
  start(): void;
  stop(): void;
  /**
   * The app came back (visibility, pageshow, online, SW nudge): reconnects now when
   * waiting out a backoff, or probes an open socket with a ping.
   */
  wake(): void;
  /** Sends on the open socket; `false` when there is none. */
  send(frame: Frame): boolean;
  readonly status: SocketStatus;
}

function text(data: unknown): string {
  return typeof data === 'string' ? data : String(data);
}

/**
 * The phone's `/ws` connection (05 Rec-5): `hello` → `hello_ok`, an application ping
 * every 25 s with a 10 s pong deadline, exponential backoff 1 → 30 s, and an immediate
 * retry on `wake`.
 */
export function createRelaySocket(options: RelaySocketOptions): RelaySocket {
  const { timer } = options;
  let status: SocketStatus = 'stopped';
  let socket: SocketLike | undefined;
  let open = false;
  let failures = 0;
  let attempt = 0;
  let retry: TimerHandle | undefined;
  let heartbeat: TimerHandle | undefined;
  let pongDeadline: TimerHandle | undefined;
  let connectDeadline: TimerHandle | undefined;

  const setStatus = (next: SocketStatus): void => {
    status = next;
    options.onStatus(next, failures);
  };

  const raw = (frame: Frame): void => {
    socket?.send(encodeFrame(frame));
  };

  const clearTimers = (): void => {
    for (const handle of [retry, heartbeat, pongDeadline, connectDeadline]) handle?.cancel();
    retry = heartbeat = pongDeadline = connectDeadline = undefined;
  };

  const ping = (): void => {
    heartbeat = undefined;
    raw({ v: VERSION_TABLE.v, kind: 'ping', t: timer.now() });
    pongDeadline = timer.after(PONG_TIMEOUT_MS, drop);
  };

  const scheduleHeartbeat = (): void => {
    heartbeat = timer.after(HEARTBEAT_MS, ping);
  };

  /** Abandons the current socket and schedules the next attempt. */
  const drop = (): void => {
    const current = socket;
    if (current === undefined) return;
    socket = undefined;
    current.onopen = current.onmessage = current.onclose = current.onerror = null;
    current.close(4000, 'reconnect');
    clearTimers();
    if (!open) failures += 1;
    open = false;
    if (status === 'stopped') return;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt);
    attempt += 1;
    setStatus('reconnecting');
    retry = timer.after(delay, connect);
  };

  const onMessage = (data: string): void => {
    const parsed = parseFrame(data);
    if (!parsed.ok) return;
    const frame = parsed.frame;
    if (frame.kind === 'hello_ok') {
      connectDeadline?.cancel();
      open = true;
      failures = 0;
      attempt = 0;
      setStatus('open');
      scheduleHeartbeat();
      options.onOpen(frame);
      return;
    }
    if (!open) return;
    if (frame.kind === 'pong') {
      pongDeadline?.cancel();
      scheduleHeartbeat();
    }
    options.onFrame(frame);
  };

  function connect(): void {
    retry = undefined;
    const current = options.createSocket(options.url);
    socket = current;
    setStatus(attempt === 0 && failures === 0 ? 'connecting' : 'reconnecting');
    connectDeadline = timer.after(CONNECT_TIMEOUT_MS, drop);
    current.onopen = () => {
      raw({
        v: VERSION_TABLE.v,
        kind: 'hello',
        protocol: { min: VERSION_TABLE.v, max: VERSION_TABLE.v },
        client: { kind: 'phone', version: options.version },
      });
    };
    current.onmessage = (event) => {
      onMessage(text(event.data));
    };
    current.onclose = drop;
    current.onerror = drop;
  }

  return {
    get status() {
      return status;
    },
    start() {
      if (status !== 'stopped') return;
      failures = 0;
      attempt = 0;
      connect();
    },
    stop() {
      setStatus('stopped');
      const current = socket;
      socket = undefined;
      open = false;
      clearTimers();
      if (current !== undefined) {
        current.onopen = current.onmessage = current.onclose = current.onerror = null;
        current.close(1000, 'bye');
      }
    },
    wake() {
      // An open socket may be dead after a suspend: probe it now instead of in 25 s.
      if (open) {
        if (heartbeat === undefined) return;
        heartbeat.cancel();
        ping();
        return;
      }
      // Only a backoff wait is cut short; an attempt in flight is left to finish.
      if (retry === undefined) return;
      retry.cancel();
      attempt = 0;
      connect();
    },
    send(frame) {
      if (!open) return false;
      raw(frame);
      return true;
    },
  };
}
