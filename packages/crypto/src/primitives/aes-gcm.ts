import { copyBytes } from '../bytes.js';
import { CryptoError } from '../errors.js';
import { getSubtle } from './subtle.js';

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
  return getSubtle().importKey('raw', copyBytes(raw), { name: 'AES-GCM' }, false, [...usages]);
}

function aesGcmParams(nonce: Uint8Array, aad: Uint8Array): AesGcmParams {
  return { name: 'AES-GCM', iv: copyBytes(nonce), additionalData: copyBytes(aad), tagLength: 128 };
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
  const params = aesGcmParams(nonce, aad);
  return new Uint8Array(await getSubtle().encrypt(params, key, copyBytes(plaintext)));
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
  const params = aesGcmParams(nonce, aad);
  try {
    return new Uint8Array(await getSubtle().decrypt(params, key, copyBytes(ciphertext)));
  } catch (error) {
    throw new CryptoError('decrypt_failed', 'AES-GCM authentication failed', { cause: error });
  }
}
