import { CryptoError } from './errors.js';

const encoder = new TextEncoder();

/** UTF-8 bytes of a string, backed by a plain `ArrayBuffer` (WebCrypto accepts it). */
export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text);
}

/** Concatenates byte strings into a new buffer. */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Copies a byte string into a fresh `ArrayBuffer`-backed `Uint8Array`. */
export function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

/** Equality of two byte strings in time independent of where they differ. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/** Decodes lower- or upper-case hex; throws on odd length or a non-hex character. */
export function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new CryptoError('invalid_argument', 'fromHex: not a hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
