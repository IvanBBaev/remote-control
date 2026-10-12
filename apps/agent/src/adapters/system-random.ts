import { webCryptoRandom } from '@remote-control/crypto';

import type { Random } from '../ports/random.js';

/** WebCrypto randomness (D3); the agent's only source of random bytes. */
export const systemRandom: Random = webCryptoRandom;
