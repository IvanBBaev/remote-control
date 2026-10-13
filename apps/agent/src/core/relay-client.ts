import {
  encodeFrame,
  parseFrame,
  VERSION_TABLE,
  type Envelope,
  type Frame,
  type HelloOk,
  type Presence,
  type RelayError,
} from '@remote-control/protocol';

import type { Random } from '../ports/random.js';
import type { Timer, TimerHandle } from '../ports/timer.js';
import type { WebSocketConnection, WebSocketFactory } from '../ports/web-socket.js';

/** First reconnect delay ceiling (D15). */
export const BACKOFF_MIN_MS = 1_000;
/** Largest reconnect delay ceiling (D15). */
export const BACKOFF_MAX_MS = 60_000;
/** The relay must answer `hello` within this time, or the socket is dropped. */
export const HELLO_OK_TIMEOUT_MS = 10_000;
/** How often a held connect attempt (`canConnect` said no) asks again. */
export const HOLD_RETRY_MS = 2_000;

/**
 * Full-jitter-half backoff: the ceiling doubles per failed attempt from 1 s up to 60 s,
 * and the delay is uniform in `[ceiling / 2, ceiling]` (drawn from the `Random` port).
 */
export function backoffDelay(attempt: number, random: Random): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(attempt, 16));
  const bytes = random.bytes(4);
  const fraction = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
  return Math.round(ceiling / 2 + (fraction / 2 ** 32) * (ceiling / 2));
}

export interface RelayClientOptions {
  /** The relay's WebSocket endpoint (`wss://…/ws`). */
  readonly url: string;
  /** The agent's bearer token. */
  readonly token: string;
  /** The `remotectl` package version, sent in `hello`. */
  readonly version: string;
  readonly webSocket: WebSocketFactory;
  readonly timer: Timer;
  readonly random: Random;
  /**
   * Asked before every connect attempt. `false` holds the attempt (for example while
   * `remotectl pair` owns the device's relay socket) and asks again after a short wait.
   */
  readonly canConnect?: () => Promise<boolean>;
  /** The relay accepted the socket; envelopes may be sent from now on. */
  readonly onReady: (helloOk: HelloOk) => void;
  /** A data envelope addressed to this agent (already acked to the relay). */
  readonly onEnvelope: (envelope: Envelope) => void;
  readonly onPresence?: (presence: Presence) => void;
  readonly onRelayError?: (error: RelayError) => void;
  /** The socket went away after `onReady`; a reconnect is already scheduled. */
  readonly onDown?: (code: number, reason: string) => void;
  /** Every connection attempt that ended, with its close code and the next delay. */
  readonly onRetry?: (code: number, reason: string, delayMs: number) => void;
}

export interface RelayClient {
  /** Opens the first connection; reconnects on every loss until {@link stop}. */
  start(): void;
  /** Sends a frame on the ready socket; `false` when the relay link is down. */
  send(frame: Frame): boolean;
  /** True between `hello_ok` and the next disconnect. */
  readonly ready: boolean;
  /** Closes the socket for good; no reconnect follows. */
  stop(): void;
}

/**
 * The agent's outbound relay link (D15, 03 §5): connects with the bearer token, sends
 * `hello` with the protocol range and package version, waits for `hello_ok`, acks every
 * data envelope it receives, and reconnects with jittered backoff (1 → 60 s) on every
 * loss. It never gives up: a disconnect is a state, not an exit.
 */
export function createRelayClient(options: RelayClientOptions): RelayClient {
  const { timer, random } = options;
  let stopped = false;
  let started = false;
  let attempt = 0;
  let socket: WebSocketConnection | undefined;
  let ready = false;
  let pendingTimer: TimerHandle | undefined;
  let helloTimer: TimerHandle | undefined;

  function schedule(ms: number, run: () => void): void {
    pendingTimer?.cancel();
    pendingTimer = timer.after(ms, () => {
      pendingTimer = undefined;
      run();
    });
  }

  function retry(code: number, reason: string): void {
    if (stopped) return;
    const delay = backoffDelay(attempt, random);
    attempt += 1;
    options.onRetry?.(code, reason, delay);
    schedule(delay, () => void connect());
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    if (options.canConnect !== undefined && !(await options.canConnect())) {
      if (!stopped) schedule(HOLD_RETRY_MS, () => void connect());
      return;
    }
    if (stopped) return;
    let open = true;
    let wasReady = false;
    const connection = options.webSocket(
      options.url,
      { authorization: `Bearer ${options.token}` },
      {
        onOpen() {
          connection.send(
            encodeFrame({
              v: VERSION_TABLE.v,
              kind: 'hello',
              protocol: { min: VERSION_TABLE.min_supported, max: VERSION_TABLE.v },
              client: { kind: 'agent', version: options.version.slice(0, 64) },
            }),
          );
          helloTimer = timer.after(HELLO_OK_TIMEOUT_MS, () =>
            connection.close(1000, 'no hello_ok'),
          );
        },
        onMessage(text) {
          if (!open) return;
          const parsed = parseFrame(text);
          if (!parsed.ok) return;
          const frame = parsed.frame;
          if (!wasReady) {
            if (frame.kind !== 'hello_ok') return;
            helloTimer?.cancel();
            wasReady = true;
            ready = true;
            attempt = 0;
            options.onReady(frame);
            return;
          }
          switch (frame.kind) {
            case 'data':
              connection.send(encodeFrame({ v: VERSION_TABLE.v, kind: 'ack', ids: [frame.id] }));
              options.onEnvelope(frame);
              return;
            case 'presence':
              options.onPresence?.(frame);
              return;
            case 'error':
              options.onRelayError?.(frame);
              return;
            default:
              // ack, pong and anything else the agent does not act on.
              return;
          }
        },
        onClose(code, reason) {
          open = false;
          helloTimer?.cancel();
          if (socket === connection) socket = undefined;
          if (wasReady) {
            ready = false;
            options.onDown?.(code, reason);
          }
          retry(code, reason);
        },
      },
    );
    socket = connection;
  }

  return {
    start() {
      if (started) return;
      started = true;
      void connect();
    },
    send(frame) {
      if (!ready || socket === undefined) return false;
      socket.send(encodeFrame(frame));
      return true;
    },
    get ready() {
      return ready;
    },
    stop() {
      stopped = true;
      ready = false;
      pendingTimer?.cancel();
      helloTimer?.cancel();
      socket?.close(1000, 'agent stopping');
      socket = undefined;
    },
  };
}
