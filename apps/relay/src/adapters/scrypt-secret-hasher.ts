// WebCrypto has no scrypt, and 02 §5.5 asks for an scrypt hash of the recovery code.
// This relay-only adapter is the single exception to the WebCrypto-only rule; it never
// runs in the browser and handles no E2E material (D3 covers phone ↔ agent crypto).
// eslint-disable-next-line no-restricted-imports -- scrypt is not available in WebCrypto.
import { scrypt, timingSafeEqual } from 'node:crypto';

import { toBase64Url, type Random } from '@remote-control/protocol';

import type { SecretHasher } from '../ports/secret-hasher.js';

const N = 32_768;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
// 128 · N · r bytes = 32 MiB for these parameters; leave headroom.
const MAX_MEMORY = 64 * 1024 * 1024;
const PREFIX = `scrypt$N=${N},r=${R},p=${P}$`;

function derive(secret: string, salt: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAX_MEMORY }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function fromBase64Url(text: string): Buffer | null {
  return /^[A-Za-z0-9_-]+$/.test(text) ? Buffer.from(text, 'base64url') : null;
}

/** `scrypt$N=32768,r=8,p=1$<salt>$<hash>` (base64url), salt from the Random port. */
export function createScryptSecretHasher(random: Random): SecretHasher {
  return {
    async hash(secret) {
      const salt = random.bytes(SALT_LENGTH);
      const key = await derive(secret, salt);
      return `${PREFIX}${toBase64Url(salt)}$${toBase64Url(key)}`;
    },
    async verify(secret, encoded) {
      if (!encoded.startsWith(PREFIX)) return false;
      const [saltText, hashText, ...rest] = encoded.slice(PREFIX.length).split('$');
      if (saltText === undefined || hashText === undefined || rest.length > 0) return false;
      const salt = fromBase64Url(saltText);
      const expected = fromBase64Url(hashText);
      if (salt === null || expected === null || expected.length !== KEY_LENGTH) return false;
      return timingSafeEqual(await derive(secret, salt), expected);
    },
  };
}
