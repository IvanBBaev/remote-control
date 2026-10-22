import { gcm } from '@noble/ciphers/aes.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { p256 } from '@noble/curves/nist.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

import type { CryptoBackend } from '../backend.js';
import { bytesEqual, copyBytes, fromHex } from '../bytes.js';
import { CryptoError } from '../errors.js';

// Key bytes live only here, keyed by the opaque `CryptoKey` look-alike handed out, so a
// noble key is as unreadable to callers as a non-extractable WebCrypto key.
const secrets = new WeakMap<CryptoKey, Uint8Array>();

function newKey(name: string, type: KeyType, usages: KeyUsage[], secret: Uint8Array): CryptoKey {
  const key: CryptoKey = Object.freeze({
    algorithm: Object.freeze({ name }),
    extractable: false,
    type,
    usages: Object.freeze([...usages]) as KeyUsage[],
  });
  secrets.set(key, copyBytes(secret));
  return key;
}

/** The bytes behind a noble key, if it is one, of algorithm `name`, allowed for `usage`. */
function secretOf(key: CryptoKey, name: string, usage: KeyUsage): Uint8Array {
  const secret = secrets.get(key);
  if (secret === undefined || key.algorithm.name !== name || !key.usages.includes(usage)) {
    throw new CryptoError('invalid_argument', `not a noble ${name} key for ${usage}`);
  }
  return secret;
}

/** Runs synchronous noble code as a backend call: a throw becomes a rejection. */
function settle<T>(compute: () => T): Promise<T> {
  return Promise.resolve().then(compute);
}

// A P-256 SubjectPublicKeyInfo with an uncompressed point, the form `getPublicKey()` and
// the Secure Enclave export: SEQUENCE { id-ecPublicKey, prime256v1 }, BIT STRING 04||x||y.
const P256_SPKI_PREFIX = fromHex('3059301306072a8648ce3d020106082a8648ce3d030107034200');
const P256_POINT_LENGTH = 65;

/**
 * Pure-JS primitives on `@noble/*` for React Native, which has no `crypto.subtle`
 * (ADR 0017). Results match WebCrypto bit for bit; both backends run the same Noise
 * vectors and property tests. Select it with `setCryptoBackend(nobleBackend)`.
 */
export const nobleBackend: CryptoBackend = {
  name: 'noble',

  sha256: (data) => settle(() => copyBytes(sha256(data))),

  hmacSha256: (key, data) => settle(() => copyBytes(hmac(sha256, key, data))),

  hkdfSha256: (ikm, salt, info, length) =>
    settle(() => copyBytes(hkdf(sha256, ikm, salt, info, length))),

  importAesGcmKey: (raw, usages) => settle(() => newKey('AES-GCM', 'secret', [...usages], raw)),

  aesGcmEncrypt: (key, nonce, aad, plaintext) =>
    settle(() =>
      copyBytes(gcm(secretOf(key, 'AES-GCM', 'encrypt'), nonce, aad).encrypt(plaintext)),
    ),

  aesGcmDecrypt: (key, nonce, aad, ciphertext) =>
    settle(() =>
      copyBytes(gcm(secretOf(key, 'AES-GCM', 'decrypt'), nonce, aad).decrypt(ciphertext)),
    ),

  importX25519PrivateKey: (scalar) =>
    settle(() => newKey('X25519', 'private', ['deriveBits'], scalar)),

  // Like WebCrypto, noble refuses an all-zero result (a low-order peer key).
  x25519: (privateKey, publicKey) =>
    settle(() =>
      copyBytes(x25519.getSharedSecret(secretOf(privateKey, 'X25519', 'deriveBits'), publicKey)),
    ),

  verifyEs256: (spki, data, signature) =>
    settle(() => {
      if (
        spki.length !== P256_SPKI_PREFIX.length + P256_POINT_LENGTH ||
        !bytesEqual(spki.subarray(0, P256_SPKI_PREFIX.length), P256_SPKI_PREFIX)
      ) {
        return false;
      }
      const point = spki.subarray(P256_SPKI_PREFIX.length);
      try {
        // WebCrypto accepts high-S signatures, and so does a Secure Enclave verifier.
        return p256.verify(signature, data, point, { lowS: false });
      } catch {
        return false;
      }
    }),
};
