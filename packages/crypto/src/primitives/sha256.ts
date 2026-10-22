import { cryptoBackend } from '../backend.js';

/** SHA-256 digest length in bytes. */
export const SHA256_LENGTH = 32;

/** SHA-256 of a byte string. */
export async function sha256(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return cryptoBackend().sha256(data);
}
