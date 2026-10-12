import type { Random } from '@remote-control/protocol';

// WebCrypto caps one getRandomValues call at 65536 bytes.
const MAX_CHUNK = 65536;

/**
 * The production `Random` adapter: WebCrypto's CSPRNG, in Node 22 and in the browser.
 * This file is the only place in the package allowed to call `getRandomValues`
 * (lint-enforced); everything else draws ephemerals through the `Random` port.
 */
export const webCryptoRandom: Random = {
  bytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let offset = 0; offset < length; offset += MAX_CHUNK) {
      globalThis.crypto.getRandomValues(out.subarray(offset, offset + MAX_CHUNK));
    }
    return out;
  },
};
