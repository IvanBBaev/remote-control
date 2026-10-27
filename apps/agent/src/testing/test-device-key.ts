import { fromHex } from '@remote-control/crypto';
import { decisionHash, toBase64Url, type CanonicalDecision } from '@remote-control/protocol';

import type { PeerDeviceKey } from '../ports/key-store.js';
import { rawToDer } from './test-passkey.js';

/**
 * The native app's Secure Enclave key in software for agent tests (M4-04): a WebCrypto
 * ES256 key signing the 32 bytes of `SHA-256(canonical decision)`, DER-encoded as
 * `SecKeyCreateSignature` returns it.
 */
export interface TestDeviceKey {
  /** What the phone hands the agent at pairing. */
  readonly paired: PeerDeviceKey;
  sign(decision: CanonicalDecision): Promise<string>;
}

export async function createTestDeviceKey(userVerified = true): Promise<TestDeviceKey> {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
  return {
    paired: { publicKey: toBase64Url(spki), userVerified },
    async sign(decision) {
      const message = fromHex(await decisionHash(decision));
      const raw = new Uint8Array(
        await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, message),
      );
      return toBase64Url(rawToDer(raw));
    },
  };
}
