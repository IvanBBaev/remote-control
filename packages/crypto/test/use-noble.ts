// Setup of the `crypto-noble` vitest project (M4-02): the Noise vectors, property tests and
// push summaries run again on the noble backend in a Hermes-like global with no
// `crypto.subtle`, so any primitive that still reaches WebCrypto fails with `unsupported`.
import { beforeAll } from 'vitest';

import { setCryptoBackend } from '../src/backend.js';
import { nobleBackend } from '../src/backends/noble.js';

const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { getRandomValues },
  });
  setCryptoBackend(nobleBackend);
});
