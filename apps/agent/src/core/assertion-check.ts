import { bytesEqual, concatBytes, sha256, utf8, verifyEs256 } from '@remote-control/crypto';
import {
  decisionChallenge,
  type CanonicalDecision,
  type DecisionAssertion,
} from '@remote-control/protocol';

import type { PeerPasskey } from '../ports/key-store.js';
import { fromBase64Url } from './from-base64url.js';

/** Why an assertion did not prove the decision; logged, never shown beyond `unverified`. */
export type AssertionFailure =
  | 'missing'
  | 'unknown_credential'
  | 'malformed'
  | 'wrong_type'
  | 'wrong_challenge'
  | 'wrong_rp'
  | 'not_user_verified'
  | 'bad_signature'
  | 'counter_replay';

export type AssertionCheckResult =
  | { readonly ok: true; readonly credentialId: string; readonly counter: number }
  | { readonly ok: false; readonly reason: AssertionFailure };

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
/** `rpIdHash` (32) + flags (1) + signature counter (4). */
const AUTH_DATA_MIN_LENGTH = 37;

const decoder = new TextDecoder('utf-8', { fatal: true });

function clientData(bytes: Uint8Array): { type?: unknown; challenge?: unknown } | undefined {
  try {
    const parsed: unknown = JSON.parse(decoder.decode(bytes));
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The agent's own check of the passkey assertion over a decision (D7 phase 2, M2-03),
 * so a relay that lies about its verification cannot make the agent act. In order: a
 * passkey the phone handed over at pairing; `clientDataJSON.type` is `webauthn.get` and
 * its `challenge` is `base64url(SHA-256(canonical decision))`; `rpIdHash` is
 * `SHA-256(rpId)`; user presence and user verification flags set; the ES256 signature
 * over `authenticatorData || SHA-256(clientDataJSON)`; and a signature counter that
 * moved forward when either side is non-zero (WebAuthn §6.1.1; synced passkeys keep 0).
 */
export async function checkAssertion(input: {
  readonly assertion: DecisionAssertion | undefined;
  readonly decision: CanonicalDecision;
  readonly passkeys: readonly PeerPasskey[];
}): Promise<AssertionCheckResult> {
  const { assertion } = input;
  if (assertion === undefined) return { ok: false, reason: 'missing' };
  const passkey = input.passkeys.find((entry) => entry.id === assertion.credentialId);
  if (passkey === undefined) return { ok: false, reason: 'unknown_credential' };
  const authData = fromBase64Url(assertion.authenticatorData);
  const clientDataJSON = fromBase64Url(assertion.clientDataJSON);
  const signature = fromBase64Url(assertion.signature);
  const publicKey = fromBase64Url(passkey.publicKey);
  if (
    authData === undefined ||
    authData.length < AUTH_DATA_MIN_LENGTH ||
    clientDataJSON === undefined ||
    signature === undefined ||
    publicKey === undefined
  ) {
    return { ok: false, reason: 'malformed' };
  }
  const client = clientData(clientDataJSON);
  if (client === undefined) return { ok: false, reason: 'malformed' };
  if (client.type !== 'webauthn.get') return { ok: false, reason: 'wrong_type' };
  if (client.challenge !== (await decisionChallenge(input.decision))) {
    return { ok: false, reason: 'wrong_challenge' };
  }
  if (!bytesEqual(authData.subarray(0, 32), await sha256(utf8(passkey.rpId)))) {
    return { ok: false, reason: 'wrong_rp' };
  }
  const flags = authData[32]!;
  if ((flags & FLAG_UP) === 0 || (flags & FLAG_UV) === 0) {
    return { ok: false, reason: 'not_user_verified' };
  }
  const signed = concatBytes(authData, await sha256(clientDataJSON));
  if (!(await verifyEs256(publicKey, signed, signature))) {
    return { ok: false, reason: 'bad_signature' };
  }
  const counter = new DataView(authData.buffer, authData.byteOffset).getUint32(33);
  if ((counter !== 0 || passkey.counter !== 0) && counter <= passkey.counter) {
    return { ok: false, reason: 'counter_replay' };
  }
  return { ok: true, credentialId: passkey.id, counter };
}
