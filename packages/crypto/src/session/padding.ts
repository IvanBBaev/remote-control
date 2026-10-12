import { CryptoError } from '../errors.js';
import { AES_GCM_TAG_LENGTH } from '../primitives/aes-gcm.js';

/** Padded plaintexts are a multiple of this many bytes, hiding exact lengths (D3, P5). */
export const PADDING_BLOCK = 256;
/** Largest transport ciphertext on the wire: the Noise message limit, 64 KiB − 1 (D3). */
export const MAX_FRAME_BYTES = 65_535;
/** Largest padded plaintext whose ciphertext (plus the GCM tag) fits in one frame. */
export const MAX_PADDED_BYTES =
  Math.floor((MAX_FRAME_BYTES - AES_GCM_TAG_LENGTH) / PADDING_BLOCK) * PADDING_BLOCK;
const LENGTH_PREFIX = 4;
/** Largest application plaintext per frame (65 276 bytes). */
export const MAX_PLAINTEXT_BYTES = MAX_PADDED_BYTES - LENGTH_PREFIX;

/**
 * Pads to the next multiple of 256 bytes: a 4-byte big-endian length, the plaintext,
 * then zeros. Throws `frame_too_large` above {@link MAX_PLAINTEXT_BYTES}.
 */
export function pad(plaintext: Uint8Array): Uint8Array<ArrayBuffer> {
  if (plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new CryptoError('frame_too_large', `Plaintext exceeds ${MAX_PLAINTEXT_BYTES} bytes`);
  }
  const size = Math.ceil((plaintext.length + LENGTH_PREFIX) / PADDING_BLOCK) * PADDING_BLOCK;
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, plaintext.length);
  out.set(plaintext, LENGTH_PREFIX);
  return out;
}

/**
 * Inverse of {@link pad}. Rejects (`decrypt_failed`) anything {@link pad} cannot have
 * produced: a size that is not a positive multiple of 256, a length beyond the block, or
 * a non-zero padding byte — so each plaintext has exactly one padded form.
 */
export function unpad(padded: Uint8Array): Uint8Array<ArrayBuffer> {
  if (
    padded.length === 0 ||
    padded.length % PADDING_BLOCK !== 0 ||
    padded.length > MAX_PADDED_BYTES
  ) {
    throw new CryptoError('decrypt_failed', 'Malformed padding: bad size');
  }
  const length = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0);
  const end = LENGTH_PREFIX + length;
  if (end > padded.length || padded.length - end >= PADDING_BLOCK) {
    throw new CryptoError('decrypt_failed', 'Malformed padding: bad length');
  }
  if (padded.subarray(end).some((byte) => byte !== 0)) {
    throw new CryptoError('decrypt_failed', 'Malformed padding: non-zero fill');
  }
  return padded.slice(LENGTH_PREFIX, end);
}
