import type { Random } from '@remote-control/protocol';

import { concatBytes, copyBytes, fromHex } from '../bytes.js';
import { CryptoError } from '../errors.js';
import { getSubtle } from './subtle.js';

/** X25519 key and shared-secret length in bytes (Noise `DHLEN`). */
export const X25519_KEY_LENGTH = 32;

/**
 * An X25519 key pair. The private key is a non-extractable `CryptoKey` (it can be stored
 * in IndexedDB but never read back as bytes); the public key is its raw 32-byte form.
 */
export interface X25519KeyPair {
  readonly privateKey: CryptoKey;
  readonly publicKey: Uint8Array<ArrayBuffer>;
}

// PKCS#8 wrapping of a raw X25519 private key (RFC 8410): WebCrypto imports X25519
// private keys only as PKCS#8 or JWK.
const PKCS8_PREFIX = fromHex('302e020100300506032b656e04220420');
// The Curve25519 base point, u = 9 (RFC 7748 §4.1): X25519(k, 9) is k's public key.
const BASE_POINT = fromHex('09'.padEnd(64, '0'));
const ALGORITHM = { name: 'X25519' };

function assertLength(bytes: Uint8Array, what: string): void {
  if (bytes.length !== X25519_KEY_LENGTH) {
    throw new CryptoError('invalid_argument', `${what} must be 32 bytes`);
  }
}

/**
 * X25519(privateKey, publicKey) (RFC 7748 §5). WebCrypto rejects a low-order public key
 * (all-zero result); that surfaces as `invalid_argument`.
 */
export async function x25519(
  privateKey: CryptoKey,
  publicKey: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  assertLength(publicKey, 'X25519 public key');
  const subtle = getSubtle();
  try {
    const peer = await subtle.importKey('raw', copyBytes(publicKey), ALGORITHM, true, []);
    const bits = await subtle.deriveBits({ name: 'X25519', public: peer }, privateKey, 256);
    return new Uint8Array(bits);
  } catch (error) {
    throw new CryptoError('invalid_argument', 'X25519 failed (invalid or low-order key)', {
      cause: error,
    });
  }
}

/** Builds a key pair from a raw 32-byte private key (clamped by X25519 itself). */
export async function x25519KeyPairFromPrivateKey(secret: Uint8Array): Promise<X25519KeyPair> {
  assertLength(secret, 'X25519 private key');
  // WebKitGTK/WPE (Linux WebKit) rejects a PKCS#8 key whose first byte is 0x00 with a
  // DataError, i.e. 1 in 256 keys. Clamping (RFC 7748 §5) clears the low three bits of
  // that byte, so 0x01 yields the same scalar and the same key, and the key never leaves
  // WebCrypto as bytes.
  const scalar = copyBytes(secret);
  if (scalar[0] === 0) scalar[0] = 1;
  const privateKey = await getSubtle().importKey(
    'pkcs8',
    concatBytes(PKCS8_PREFIX, scalar),
    ALGORITHM,
    false,
    ['deriveBits'],
  );
  return { privateKey, publicKey: await x25519(privateKey, BASE_POINT) };
}

/**
 * Generates a key pair from 32 bytes of the `Random` port, so tests and published vectors
 * can fix the key (Noise `GENERATE_KEYPAIR`).
 */
export async function generateX25519KeyPair(random: Random): Promise<X25519KeyPair> {
  return x25519KeyPairFromPrivateKey(random.bytes(X25519_KEY_LENGTH));
}
