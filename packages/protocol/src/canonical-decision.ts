import { z } from 'zod';

import { SETTINGS_DESTINATIONS } from './domain/always-destination.js';
import { DeviceId, RequestId, Sha256Hex } from './ids.js';
import { VERSION_TABLE } from './version.js';

/** A decision is valid for this many seconds after it is issued (D7). */
export const DECISION_TTL_SECONDS = 300;

/**
 * What the phone decides. `terminal` is "Reply in terminal" (release, D10); it and
 * `deny` touch nothing on the machine, every other kind needs a WebAuthn assertion.
 */
export const DecisionKind = z.enum([
  'allow',
  'always',
  'deny',
  'terminal',
  'answer',
  'instruct',
  'start',
]);
export type DecisionKind = z.infer<typeof DecisionKind>;

const KINDS_WITHOUT_PAYLOAD: ReadonlySet<DecisionKind> = new Set(['allow', 'deny', 'terminal']);

/**
 * `always` signs where its rules go (M2-07): `null` for the session (D24, M1 phones), or
 * `localSettings` / `projectSettings` when the agent offered them.
 */
function payloadFits(kind: DecisionKind, payload: string | null): boolean {
  if (kind === 'always') return payload === null || SETTINGS_DESTINATIONS.has(payload);
  return (payload === null) === KINDS_WITHOUT_PAYLOAD.has(kind);
}

/**
 * The exact object the phone hashes into the WebAuthn challenge and the agent re-checks
 * (D7, 02 §5.4). Field names are snake_case because they are part of the signed bytes.
 * `payload` carries the answer, instruction text, repository id or an `always` settings
 * destination, and is `null` for the kinds that carry nothing.
 */
export const CanonicalDecision = z
  .strictObject({
    v: z.literal(VERSION_TABLE.v),
    kind: DecisionKind,
    request_id: RequestId,
    request_hash: Sha256Hex,
    payload: z.string().max(16_384).nullable(),
    /** Unix seconds. */
    issued_at: z.int().nonnegative(),
    /** Unix seconds; always `issued_at + 300`. */
    expires_at: z.int().nonnegative(),
    phone_device_id: DeviceId,
    agent_device_id: DeviceId,
  })
  .refine((d) => d.expires_at === d.issued_at + DECISION_TTL_SECONDS, {
    message: `expires_at must equal issued_at + ${DECISION_TTL_SECONDS}`,
    path: ['expires_at'],
  })
  .refine((d) => payloadFits(d.kind, d.payload), {
    message:
      'payload must be null exactly for allow, deny and terminal; for always null or a settings destination',
    path: ['payload'],
  });
export type CanonicalDecision = z.infer<typeof CanonicalDecision>;
