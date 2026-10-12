import { z } from 'zod';

import { DeviceId, EnvelopeId, EpochMs, SessionId } from './ids.js';
import { VERSION_TABLE } from './version.js';

/** Largest accepted payload, in base64 characters (~192 KiB of ciphertext). */
export const MAX_PAYLOAD_LENGTH = 262_144;

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
  /** Opaque AEAD ciphertext, base64. */
  payload: z.base64().max(MAX_PAYLOAD_LENGTH),
});
export type Envelope = z.infer<typeof Envelope>;
