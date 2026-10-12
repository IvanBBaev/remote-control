import { CryptoError } from '../errors.js';

/**
 * The platform's WebCrypto `SubtleCrypto` (D3: every primitive comes from here, in Node 22
 * and in the browser alike). Throws `unsupported` when the platform has none, for example
 * an insecure (non-HTTPS) browser context.
 */
export function getSubtle(): SubtleCrypto {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (subtle === undefined) {
    throw new CryptoError('unsupported', 'WebCrypto (crypto.subtle) is not available');
  }
  return subtle;
}
