import { cryptoBackend } from '../backend.js';
import { CryptoError } from '../errors.js';

/** Largest HKDF-SHA-256 output (RFC 5869 §2.3: 255 × HashLen). */
export const HKDF_SHA256_MAX_LENGTH = 255 * 32;

/**
 * HKDF-SHA-256 (RFC 5869). An empty `salt` means HashLen zero bytes,
 * as the RFC specifies. `length` is in bytes.
 */
export async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isInteger(length) || length < 1 || length > HKDF_SHA256_MAX_LENGTH) {
    throw new CryptoError('invalid_argument', 'hkdfSha256: length out of range');
  }
  return cryptoBackend().hkdfSha256(ikm, salt, info, length);
}
