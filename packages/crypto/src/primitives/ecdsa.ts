import { copyBytes } from '../bytes.js';
import { getSubtle } from './subtle.js';

/** Length of one P-256 scalar, and so of `r` and `s` in a raw signature. */
const P256_SCALAR_LENGTH = 32;

/**
 * One DER `INTEGER` as WebAuthn ES256 signatures encode `r` and `s`: short-form length,
 * positive, minimal (a leading zero only before a byte with the high bit set), at most
 * 32 bytes once that zero is gone. Returns the 32-byte big-endian value and the offset
 * after it, or `undefined`.
 */
function readInteger(
  der: Uint8Array,
  offset: number,
): { value: Uint8Array; next: number } | undefined {
  if (der[offset] !== 0x02) return undefined;
  const length = der[offset + 1];
  if (length === undefined || length === 0 || length > 0x7f) return undefined;
  const start = offset + 2;
  const end = start + length;
  if (end > der.length) return undefined;
  let bytes = der.subarray(start, end);
  if ((bytes[0]! & 0x80) !== 0) return undefined;
  if (bytes[0] === 0) {
    if (bytes.length === 1 || (bytes[1]! & 0x80) === 0) return undefined;
    bytes = bytes.subarray(1);
  }
  if (bytes.length > P256_SCALAR_LENGTH) return undefined;
  const value = new Uint8Array(P256_SCALAR_LENGTH);
  value.set(bytes, P256_SCALAR_LENGTH - bytes.length);
  return { value, next: end };
}

/**
 * A DER `SEQUENCE { r INTEGER, s INTEGER }` (the WebAuthn ES256 signature format) as the
 * 64-byte `r || s` WebCrypto verifies. Strict: no trailing bytes, no long-form lengths,
 * no non-minimal integers. Returns `undefined` for anything else.
 */
export function es256DerToRaw(der: Uint8Array): Uint8Array<ArrayBuffer> | undefined {
  if (der[0] !== 0x30 || der[1] === undefined || der[1] > 0x7f) return undefined;
  if (der[1] !== der.length - 2) return undefined;
  const r = readInteger(der, 2);
  const s = r && readInteger(der, r.next);
  if (r === undefined || s === undefined || s.next !== der.length) return undefined;
  const raw = new Uint8Array(2 * P256_SCALAR_LENGTH);
  raw.set(r.value, 0);
  raw.set(s.value, P256_SCALAR_LENGTH);
  return raw;
}

/**
 * Verifies an ES256 (ECDSA P-256 with SHA-256) signature in DER form over `data` with a
 * public key in SubjectPublicKeyInfo form, as `getPublicKey()` returns it for a passkey.
 * Any malformed key or signature is `false`, never an exception: the caller only needs
 * to know whether the signature proves possession of the key.
 */
export async function verifyEs256(
  spki: Uint8Array,
  data: Uint8Array,
  derSignature: Uint8Array,
): Promise<boolean> {
  const signature = es256DerToRaw(derSignature);
  if (signature === undefined) return false;
  const subtle = getSubtle();
  let key: CryptoKey;
  try {
    key = await subtle.importKey(
      'spki',
      copyBytes(spki),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
  } catch {
    return false;
  }
  return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, copyBytes(data));
}
