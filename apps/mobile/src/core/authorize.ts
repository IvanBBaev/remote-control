import { concatBytes, fromHex } from '@remote-control/crypto';
import { decisionHash, requiresAssertion, toBase64Url } from '@remote-control/protocol';
import type { CanonicalDecision, DecisionKind, PairedDeviceKey } from '@remote-control/protocol';
import type {
  AssertDecisionResult,
  DeleteAccountResult,
} from '@remote-control/phone-core/auth/results';

/**
 * The app's device signing key (ADR 0017, M4-04): a P-256 key in the Secure Enclave
 * that signs only after the currently enrolled Face ID / Touch ID.
 */
export interface DeviceSigner {
  /** The public key as an uncompressed X9.63 point (65 bytes), created on first use. */
  publicKey(): Promise<Uint8Array>;
  /** DER ECDSA P-256 over SHA-256(`message`) after biometry; `null` when the user cancels. */
  sign(message: Uint8Array, reason: string): Promise<Uint8Array | null>;
}

/** The DER prefix of a P-256 `SubjectPublicKeyInfo` in front of the raw point (RFC 5480). */
const P256_SPKI_PREFIX = fromHex('3059301306072a8648ce3d020106082a8648ce3d030107034200');

/** Wraps an uncompressed P-256 point into the SPKI form the agent verifies against. */
export function spkiFromRawP256(raw: Uint8Array): Uint8Array {
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error('not an uncompressed P-256 point');
  return concatBytes(P256_SPKI_PREFIX, raw);
}

/**
 * The key the app hands over in pairing msg3. Its access control requires biometry on
 * every use, so the agent may treat it as user-verified. `undefined` when the phone
 * cannot make the key: the app then pairs without one and cannot allow.
 */
export async function pairedDeviceKey(signer: DeviceSigner): Promise<PairedDeviceKey | undefined> {
  try {
    return {
      publicKey: toBase64Url(spkiFromRawP256(await signer.publicKey())),
      userVerified: true,
    };
  } catch {
    return undefined;
  }
}

/** What the Face ID sheet says for each kind that needs a signature. */
const REASONS: Readonly<Record<DecisionKind, string>> = {
  allow: 'Allow this request',
  always: 'Always allow this tool',
  answer: 'Send this answer',
  instruct: 'Send this instruction',
  start: 'Start this session',
  deny: 'Deny this request',
  terminal: 'Reply in the terminal',
};

/**
 * The app's decision binding: Deny and "Reply in terminal" go out with their hash
 * alone (D7); every other kind carries the device key's signature over the decision
 * hash, which only the agent checks (I4).
 */
export function authorizeWithDeviceKey(
  signer: DeviceSigner,
): (decision: CanonicalDecision) => Promise<AssertDecisionResult> {
  return async (decision) => {
    const hash = await decisionHash(decision);
    if (!requiresAssertion(decision.kind)) return { ok: true, decisionHash: hash, asserted: false };
    let signature: Uint8Array | null;
    try {
      signature = await signer.sign(fromHex(hash), REASONS[decision.kind]);
    } catch {
      return { ok: false, failure: 'failed' };
    }
    if (signature === null) return { ok: false, failure: 'cancelled' };
    return {
      ok: true,
      decisionHash: hash,
      asserted: true,
      deviceSignature: toBase64Url(signature),
    };
  };
}

/** Account deletion needs a passkey assertion (M1-10), which the app does not have. */
export function deleteAccountWithoutPasskey(): Promise<DeleteAccountResult> {
  return Promise.resolve({ ok: false, failure: 'cancelled' });
}
