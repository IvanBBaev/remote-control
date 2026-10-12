import { concatBytes } from '../bytes.js';
import { hmacSha256 } from '../primitives/hmac.js';

/**
 * Noise `HKDF(chaining_key, input_key_material, num_outputs)` (Noise §4.3), written out
 * over HMAC-SHA-256 as the spec defines it. The HMAC key is always the 32-byte chaining
 * key or a 32-byte temp key, never empty, so it works on every WebCrypto (an empty
 * `input_key_material`, as in `Split()`, is data, not a key).
 */
export async function noiseHkdf(
  chainingKey: Uint8Array,
  inputKeyMaterial: Uint8Array,
  outputs: 2 | 3,
): Promise<Uint8Array<ArrayBuffer>[]> {
  const tempKey = await hmacSha256(chainingKey, inputKeyMaterial);
  const out1 = await hmacSha256(tempKey, Uint8Array.of(1));
  const out2 = await hmacSha256(tempKey, concatBytes(out1, Uint8Array.of(2)));
  if (outputs === 2) return [out1, out2];
  return [out1, out2, await hmacSha256(tempKey, concatBytes(out2, Uint8Array.of(3)))];
}
