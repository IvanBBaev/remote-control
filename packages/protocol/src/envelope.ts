import { z } from 'zod';

import { DeviceId, EnvelopeId, EpochMs, SessionId, Sha256Hex } from './ids.js';
import { VERSION_TABLE } from './version.js';

/**
 * Largest accepted payload, in base64 characters: one Noise transport frame of at most
 * 65 535 bytes (D3) encodes to 87 380 characters, which keeps a full envelope well under
 * the relay's 256 KiB WebSocket frame cap (D15).
 */
export const MAX_PAYLOAD_LENGTH = 87_380;

/** Largest push summary blob, in base64 characters: 1 KiB sealed (D5) encodes to 1 368. */
export const MAX_PUSH_BLOB_LENGTH = 1_368;

/**
 * Data envelope (D14). Everything except `payload` is routing metadata the relay may
 * read; `payload` is end-to-end ciphertext the relay never decodes (I3).
 */
export const Envelope = z.strictObject({
  v: z.literal(VERSION_TABLE.v),
  kind: z.literal('data'),
  /** Sender-generated UUIDv7; dedup key together with `from`. */
  id: EnvelopeId,
  from: DeviceId,
  /** `null` fans out to every other device of the same user (D25). */
  to: DeviceId.nullable(),
  /** Agent session id, or `null` for machine-level traffic. */
  session: SessionId.nullable(),
  cls: z.enum(['request', 'reply', 'command', 'event', 'control']),
  /** Monotonic per `(from, session)`. */
  seq: z.int().nonnegative(),
  /** Sender clock, informational only. */
  ts: EpochMs,
  /** The relay drops the envelope after this instant; `null` = no expiry. */
  expiresAt: EpochMs.nullable(),
  /** For `cls: reply`, the id of the envelope being answered. */
  replyTo: EnvelopeId.optional(),
  /**
   * For `cls: command`, the hex SHA-256 of the canonical decision the phone signed (D7).
   * The relay forwards such a command only after it verified a passkey assertion over
   * this hash (M0-11); a command without it carries a deny or terminate decision.
   */
  decisionHash: Sha256Hex.optional(),
  /**
   * For `cls: request`, the push summary sealed under the pairing's notification key
   * (D5, M1-06), base64. The relay copies it verbatim into the push it may send and
   * never decodes, logs or stores it (I2, I3).
   */
  pushBlob: z.base64().max(MAX_PUSH_BLOB_LENGTH).optional(),
  /** Opaque AEAD ciphertext, base64. */
  payload: z.base64().max(MAX_PAYLOAD_LENGTH),
});
export type Envelope = z.infer<typeof Envelope>;
