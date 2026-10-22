import type { Random } from '@remote-control/protocol';

import { cryptoBackend } from '../backend.js';
import { fromHex } from '../bytes.js';
import { CryptoError } from '../errors.js';

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

// The Curve25519 base point, u = 9 (RFC 7748 §4.1): X25519(k, 9) is k's public key.
const BASE_POINT = fromHex('09'.padEnd(64, '0'));

function assertLength(bytes: Uint8Array, what: string): void {
  if (bytes.length !== X25519_KEY_LENGTH) {
    throw new CryptoError('invalid_argument', `${what} must be 32 bytes`);
  }
}

/**
 * X25519(privateKey, publicKey) (RFC 7748 §5). A low-order public key (all-zero result)
 * or a key from another backend surfaces as `invalid_argument`.
 */
export async function x25519(
  privateKey: CryptoKey,
  publicKey: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  assertLength(publicKey, 'X25519 public key');
  try {
    return await cryptoBackend().x25519(privateKey, publicKey);
  } catch (error) {
    throw new CryptoError('invalid_argument', 'X25519 failed (invalid or low-order key)', {
      cause: error,
    });
  }
}

/** Builds a key pair from a raw 32-byte private key (clamped by X25519 itself). */
export async function x25519KeyPairFromPrivateKey(secret: Uint8Array): Promise<X25519KeyPair> {
  assertLength(secret, 'X25519 private key');
  const privateKey = await cryptoBackend().importX25519PrivateKey(secret);
  return { privateKey, publicKey: await x25519(privateKey, BASE_POINT) };
}

/**
 * Generates a key pair from 32 bytes of the `Random` port, so tests and published vectors
 * can fix the key (Noise `GENERATE_KEYPAIR`).
 */
export async function generateX25519KeyPair(random: Random): Promise<X25519KeyPair> {
  return x25519KeyPairFromPrivateKey(random.bytes(X25519_KEY_LENGTH));
}
