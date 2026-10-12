/**
 * The structured fields every service logs (ROADMAP D19, report 06 §5.5). All are
 * metadata: `user_id` is opaque, `bytes` is a length, never the bytes themselves.
 */
export interface LogFields {
  /** Request id; on the relay this is `X-Railway-Request-Id`. */
  readonly req_id?: string;
  /** Opaque user id. */
  readonly user_id?: string;
  readonly device_id?: string;
  /** Event name, e.g. `envelope_forwarded`. */
  readonly event?: string;
  /** Byte length of a frame or body. */
  readonly bytes?: number;
  readonly duration_ms?: number;
  readonly ws_close_code?: number;
}

/** The names of {@link LogFields}, in documentation order. */
export const LOG_FIELDS = Object.freeze([
  'req_id',
  'user_id',
  'device_id',
  'event',
  'bytes',
  'duration_ms',
  'ws_close_code',
] as const satisfies readonly (keyof LogFields)[]);
