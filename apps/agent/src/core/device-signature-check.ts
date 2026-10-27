import { fromHex, verifyEs256 } from '@remote-control/crypto';
import { decisionHash, type CanonicalDecision } from '@remote-control/protocol';

import type { PeerDeviceKey } from '../ports/key-store.js';
import { fromBase64Url } from './from-base64url.js';

/** Why a device signature did not prove the decision; logged, never shown beyond `unverified`. */
export type DeviceSignatureFailure =
  'missing' | 'not_user_verified' | 'malformed' | 'bad_signature';

export type DeviceSignatureCheckResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: DeviceSignatureFailure };

/**
 * The agent's own check of a native app's device-key signature over a decision (ADR 0017,
 * M4-04): an ES256 (DER) signature by the Secure Enclave key the phone handed over at
 * pairing, over the 32 bytes of `SHA-256(canonical decision)`. A key the phone did not
 * declare as gated by user verification never proves a decision. There is no counter:
 * decide-once and the request's expiry cover a replay.
 */
export async function checkDeviceSignature(input: {
  readonly signature: string | undefined;
  readonly decision: CanonicalDecision;
  readonly deviceKey: PeerDeviceKey | undefined;
}): Promise<DeviceSignatureCheckResult> {
  const { signature, deviceKey } = input;
  if (signature === undefined || deviceKey === undefined) return { ok: false, reason: 'missing' };
  if (!deviceKey.userVerified) return { ok: false, reason: 'not_user_verified' };
  const der = fromBase64Url(signature);
  const publicKey = fromBase64Url(deviceKey.publicKey);
  if (der === undefined || publicKey === undefined) return { ok: false, reason: 'malformed' };
  const message = fromHex(await decisionHash(input.decision));
  if (!(await verifyEs256(publicKey, message, der))) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true };
}
