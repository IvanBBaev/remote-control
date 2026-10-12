import type { Random } from '@remote-control/protocol';

/** WebCrypto randomness; the only place in this package allowed to draw random bytes. */
export const systemRandom: Random = {
  bytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
};
