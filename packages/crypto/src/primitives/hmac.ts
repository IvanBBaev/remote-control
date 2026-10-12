import { copyBytes } from '../bytes.js';
import { getSubtle } from './subtle.js';

/** HMAC-SHA-256 of `data` under `key` (the key must not be empty; WebCrypto refuses it). */
export async function hmacSha256(
  key: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const subtle = getSubtle();
  const hmacKey = await subtle.importKey(
    'raw',
    copyBytes(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await subtle.sign('HMAC', hmacKey, copyBytes(data)));
}
