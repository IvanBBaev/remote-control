/** Relay runtime limits and timings (D15, 03 §5.1–5.4, 03 §5.13). */

/** The relay pings every socket this often. */
export const PING_INTERVAL_MS = 25_000;
/** A socket silent (no frame, no pong) for this long is terminated. */
export const SILENCE_LIMIT_MS = 35_000;
/** A socket must send `hello` within this time, or it is closed with 1008. */
export const HELLO_TIMEOUT_MS = 10_000;
/** Largest inbound frame; `ws` closes a larger one with 1009. */
export const MAX_FRAME_BYTES = 262_144;
/** Inbound frames per second per socket; more closes with 1008. */
export const FRAMES_PER_SECOND = 100;
/** Above this many queued outbound bytes, frames to the socket are dropped. */
export const BACKPRESSURE_BYTES = 1_048_576;
/** Live devices per user (D25). */
export const DEVICE_CAP = 10;
/** `devices.last_seen_at` is written at most this often while a device stays connected. */
export const LAST_SEEN_INTERVAL_MS = 60_000;
/** After a 1012 close on shutdown, a peer that does not answer is terminated after this. */
export const CLOSE_GRACE_MS = 5_000;

/** WebSocket close codes the relay uses. */
export const CloseCode = {
  /** Unknown key, bad frame, wrong sender, rate limit, device cap (D14, D15). */
  policy: 1008,
  /** Frame above {@link MAX_FRAME_BYTES} (sent by `ws` itself). */
  tooBig: 1009,
  /** Graceful shutdown: reconnect now, with jitter (03 §5.13). */
  serviceRestart: 1012,
  /** A newer socket for the same device took over (03 H). */
  superseded: 4000,
  /** No common protocol version (D14). */
  unsupportedVersion: 4001,
} as const;
