import { cryptoBackend } from '../backend.js';
import { CryptoError } from '../errors.js';

/** AES-256 key length in bytes. */
export const AES_256_KEY_LENGTH = 32;
/** AES-GCM nonce length in bytes. */
export const AES_GCM_NONCE_LENGTH = 12;
/** AES-GCM authentication tag length in bytes. */
export const AES_GCM_TAG_LENGTH = 16;

/** Imports a raw 32-byte AES-256-GCM key as a non-extractable `CryptoKey`. */
export async function importAesGcmKey(
  raw: Uint8Array,
  usages: readonly ('encrypt' | 'decrypt')[] = ['encrypt', 'decrypt'],
): Promise<CryptoKey> {
  if (raw.length !== AES_256_KEY_LENGTH) {
    throw new CryptoError('invalid_argument', 'importAesGcmKey: key must be 32 bytes');
  }
  return cryptoBackend().importAesGcmKey(raw, usages);
}

function assertNonce(nonce: Uint8Array): void {
  if (nonce.length !== AES_GCM_NONCE_LENGTH) {
    throw new CryptoError('invalid_argument', 'AES-GCM nonce must be 12 bytes');
  }
}

/** AES-256-GCM encryption; returns `ciphertext || tag` (128-bit tag). */
export async function aesGcmEncrypt(
  key: CryptoKey,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  assertNonce(nonce);
  return cryptoBackend().aesGcmEncrypt(key, nonce, aad, plaintext);
}

/**
 * AES-256-GCM decryption of `ciphertext || tag`. Any authentication failure (wrong key,
 * nonce, AAD, or a modified or truncated ciphertext) throws `decrypt_failed`.
 */
export async function aesGcmDecrypt(
  key: CryptoKey,
  nonce: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  assertNonce(nonce);
  if (ciphertext.length < AES_GCM_TAG_LENGTH) {
    throw new CryptoError('decrypt_failed', 'AES-GCM ciphertext shorter than the tag');
  }
  try {
    return await cryptoBackend().aesGcmDecrypt(key, nonce, aad, ciphertext);
  } catch (error) {
    throw new CryptoError('decrypt_failed', 'AES-GCM authentication failed', { cause: error });
  }
}
