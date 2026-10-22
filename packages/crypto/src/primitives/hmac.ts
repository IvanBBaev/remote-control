import { cryptoBackend } from '../backend.js';
import { CryptoError } from '../errors.js';

/** HMAC-SHA-256 of `data` under `key`. The key must not be empty (WebCrypto refuses it). */
export async function hmacSha256(
  key: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  if (key.length === 0) throw new CryptoError('invalid_argument', 'hmacSha256: empty key');
  return cryptoBackend().hmacSha256(key, data);
}
