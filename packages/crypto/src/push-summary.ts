import type { Random } from '@remote-control/protocol';

import { concatBytes, utf8 } from './bytes.js';
import { CryptoError } from './errors.js';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  AES_GCM_NONCE_LENGTH,
  AES_GCM_TAG_LENGTH,
} from './primitives/aes-gcm.js';

/** Largest sealed push summary: `nonce || ciphertext || tag` (D5: at most 1 KiB). */
export const MAX_PUSH_SUMMARY_BYTES = 1024;
/** Largest summary plaintext that still seals within {@link MAX_PUSH_SUMMARY_BYTES}. */
export const MAX_PUSH_SUMMARY_PLAINTEXT_BYTES =
  MAX_PUSH_SUMMARY_BYTES - AES_GCM_NONCE_LENGTH - AES_GCM_TAG_LENGTH;

/**
 * The summary's associated data: the id of the envelope that carries it. The push names
 * that id (`rid`), so the relay cannot move a summary onto another request's push.
 */
function summaryAad(envelopeId: string): Uint8Array<ArrayBuffer> {
  return utf8(`rc/v1/push${envelopeId}`);
}

/**
 * Seals a push summary under the pairing's notification key (D5): AES-256-GCM with a
 * random 96-bit nonce (the key is static, so the nonce cannot be a counter), returned as
 * `nonce || ciphertext || tag`.
 */
export async function sealPushSummary(
  key: CryptoKey,
  envelopeId: string,
  plaintext: Uint8Array,
  random: Random,
): Promise<Uint8Array<ArrayBuffer>> {
  if (plaintext.length > MAX_PUSH_SUMMARY_PLAINTEXT_BYTES) {
    throw new CryptoError('invalid_argument', 'push summary exceeds 1 KiB sealed');
  }
  const nonce = random.bytes(AES_GCM_NONCE_LENGTH);
  return concatBytes(nonce, await aesGcmEncrypt(key, nonce, summaryAad(envelopeId), plaintext));
}

/** Opens a sealed push summary; throws `decrypt_failed` on any mismatch or tampering. */
export async function openPushSummary(
  key: CryptoKey,
  envelopeId: string,
  sealed: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  if (sealed.length < AES_GCM_NONCE_LENGTH + AES_GCM_TAG_LENGTH) {
    throw new CryptoError('decrypt_failed', 'push summary too short');
  }
  if (sealed.length > MAX_PUSH_SUMMARY_BYTES) {
    throw new CryptoError('decrypt_failed', 'push summary too long');
  }
  return aesGcmDecrypt(
    key,
    sealed.subarray(0, AES_GCM_NONCE_LENGTH),
    summaryAad(envelopeId),
    sealed.subarray(AES_GCM_NONCE_LENGTH),
  );
}
