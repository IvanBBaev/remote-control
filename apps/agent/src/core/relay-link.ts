import type { Timer } from '../ports/timer.js';
import type { WebSocketFactory } from '../ports/web-socket.js';
import { createRelayClient, type RelayClient } from './relay-client.js';
import {
  createSessionHub,
  type HubLog,
  type SessionHub,
  type SessionHubOptions,
} from './session-hub.js';

export interface RelayLinkOptions extends Omit<SessionHubOptions, 'send' | 'log'> {
  /** The relay's WebSocket endpoint. */
  readonly url: string;
  /** The agent's relay bearer token (`relay.json`). */
  readonly token: string;
  /** The `remotectl` package version, sent in `hello`. */
  readonly version: string;
  readonly webSocket: WebSocketFactory;
  readonly timer: Timer;
  /** See {@link RelayClientOptions.canConnect}. */
  readonly canConnect?: () => Promise<boolean>;
  /** Event names, ids and codes only (I3). */
  readonly log?: HubLog;
}

export interface RelayLink {
  readonly client: RelayClient;
  readonly hub: SessionHub;
  start(): void;
  stop(): void;
}

/**
 * The relay client and the session hub, wired together: `hello_ok` opens the hub,
 * envelopes and presence feed it, and a lost link ends every session until the next
 * `hello_ok` (the phones then run a new KK handshake and get the pending set again).
 */
export function createRelayLink(options: RelayLinkOptions): RelayLink {
  const log: HubLog = options.log ?? (() => undefined);
  // The hub only sends after `hello_ok`, so `client` is always initialised by then.
  const hub = createSessionHub({
    ...options,
    log,
    send: (envelope) => client.send(envelope),
  });
  const client: RelayClient = createRelayClient({
    url: options.url,
    token: options.token,
    version: options.version,
    webSocket: options.webSocket,
    timer: options.timer,
    random: options.random,
    ...(options.canConnect === undefined ? {} : { canConnect: options.canConnect }),
    onReady(helloOk) {
      log('relay_ready', { device_id: helloOk.deviceId, protocol: helloOk.protocol });
      hub.relayReady(helloOk.deviceId, helloOk.presence);
    },
    onEnvelope: (envelope) => hub.envelope(envelope),
    onPresence: (presence) => hub.presence(presence),
    onRelayError: (error) => log('relay_error', { code: error.code, ref: error.ref }),
    onDown(code, reason) {
      log('relay_down', { code, reason });
      hub.relayDown();
    },
    onRetry: (code, reason, delayMs) => log('relay_retry', { code, reason, delay_ms: delayMs }),
  });
  return {
    client,
    hub,
    start: () => client.start(),
    stop: () => client.stop(),
  };
}
