import { getRandomValues } from 'expo-crypto';
import type { Random } from '@remote-control/protocol';

// One `getRandomValues` call is capped at 65536 bytes, as in WebCrypto.
const MAX_CHUNK = 65536;

/**
 * The platform CSPRNG (expo-crypto: `SecRandomCopyBytes` on iOS). The only file in the app
 * allowed to draw randomness (lint-enforced); everything else takes the `Random` port.
 */
export const systemRandom: Random = {
  bytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let offset = 0; offset < length; offset += MAX_CHUNK) {
      getRandomValues(out.subarray(offset, offset + MAX_CHUNK));
    }
    return out;
  },
};

/** Gives Hermes a `crypto.getRandomValues` for shared code that reaches for the global. */
export function installRandomValues(target: {
  crypto?: { getRandomValues?: Crypto['getRandomValues'] };
}): void {
  const crypto = (target.crypto ??= {});
  if (typeof crypto.getRandomValues === 'function') return;
  crypto.getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
    if (array !== null) {
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      bytes.set(systemRandom.bytes(bytes.length));
    }
    return array;
  };
}
