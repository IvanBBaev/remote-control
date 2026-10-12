// Unit tests of the byte helpers, the WebCrypto primitives, the capability probe and the
// randomness adapter. Browser-safe: no `node:*` imports.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { webCryptoRandom } from './adapters/web-crypto-random.js';
import { bytesEqual, concatBytes, fromHex, utf8 } from './bytes.js';
import { CryptoError } from './errors.js';
import { aesGcmDecrypt, aesGcmEncrypt, importAesGcmKey } from './primitives/aes-gcm.js';
import { hkdfSha256, HKDF_SHA256_MAX_LENGTH } from './primitives/hkdf.js';
import { probeWebCrypto } from './primitives/probe.js';
import { getSubtle } from './primitives/subtle.js';
import { x25519, x25519KeyPairFromPrivateKey } from './primitives/x25519.js';

const code = (expected: string) =>
  expect.objectContaining({ name: 'CryptoError', code: expected }) as unknown;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('bytes', () => {
  it('compares byte strings', () => {
    expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
    expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
    expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1))).toBe(false);
  });

  it('decodes hex and rejects anything else', () => {
    expect(fromHex('00Ff10')).toEqual(Uint8Array.of(0, 255, 16));
    expect(() => fromHex('abc')).toThrow(CryptoError);
    expect(() => fromHex('zz')).toThrow(CryptoError);
  });

  it('concatenates', () => {
    expect(concatBytes(utf8('ab'), new Uint8Array(0), Uint8Array.of(1))).toEqual(
      Uint8Array.of(97, 98, 1),
    );
  });
});

describe('getSubtle', () => {
  it('throws unsupported without WebCrypto', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => getSubtle()).toThrow(code('unsupported'));
  });
});

describe('probeWebCrypto', () => {
  it('reports a complete platform as ok', async () => {
    expect(await probeWebCrypto()).toEqual({ ok: true, missing: [] });
  });

  it('reports a platform without crypto.subtle', async () => {
    vi.stubGlobal('crypto', undefined);
    expect(await probeWebCrypto()).toEqual({ ok: false, missing: ['subtle'] });
  });

  it('reports every capability whose operation fails', async () => {
    const reject = (): Promise<never> => Promise.reject(new Error('not supported'));
    const broken = {
      digest: reject,
      importKey: reject,
      sign: reject,
      deriveBits: reject,
      encrypt: reject,
    } as unknown as SubtleCrypto;
    expect(await probeWebCrypto(broken)).toEqual({
      ok: false,
      missing: ['sha256', 'hmac', 'hkdf', 'aes-gcm', 'x25519'],
    });
  });

  it('rejects an X25519 implementation that returns a wrong result', async () => {
    const real = crypto.subtle;
    const wrong = new Proxy(real, {
      get(target, property) {
        if (property === 'deriveBits') {
          return (algorithm: { name: string }, key: CryptoKey, length: number) =>
            algorithm.name === 'X25519'
              ? Promise.resolve(new ArrayBuffer(32))
              : target.deriveBits(algorithm, key, length);
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
    expect(await probeWebCrypto(wrong)).toEqual({ ok: false, missing: ['x25519'] });
  });
});

describe('AES-256-GCM', () => {
  const nonce = new Uint8Array(12);

  it('round-trips and authenticates the AAD', async () => {
    const key = await importAesGcmKey(new Uint8Array(32).fill(3));
    const ciphertext = await aesGcmEncrypt(key, nonce, utf8('aad'), utf8('hello'));
    expect(ciphertext.length).toBe(5 + 16);
    expect(await aesGcmDecrypt(key, nonce, utf8('aad'), ciphertext)).toEqual(utf8('hello'));
    await expect(aesGcmDecrypt(key, nonce, utf8('aaD'), ciphertext)).rejects.toEqual(
      code('decrypt_failed'),
    );
  });

  it('rejects bad key, nonce and ciphertext lengths', async () => {
    const key = await importAesGcmKey(new Uint8Array(32));
    await expect(importAesGcmKey(new Uint8Array(16))).rejects.toEqual(code('invalid_argument'));
    await expect(aesGcmEncrypt(key, new Uint8Array(8), utf8(''), utf8('x'))).rejects.toEqual(
      code('invalid_argument'),
    );
    await expect(
      aesGcmDecrypt(key, new Uint8Array(13), utf8(''), new Uint8Array(16)),
    ).rejects.toEqual(code('invalid_argument'));
    await expect(aesGcmDecrypt(key, nonce, utf8(''), new Uint8Array(15))).rejects.toEqual(
      code('decrypt_failed'),
    );
  });

  it('imports a key with only the given usages', async () => {
    const key = await importAesGcmKey(new Uint8Array(32), ['decrypt']);
    expect(key.extractable).toBe(false);
    expect(key.usages).toEqual(['decrypt']);
    await expect(aesGcmEncrypt(key, nonce, utf8(''), utf8('x'))).rejects.toThrow();
  });
});

describe('HKDF-SHA-256', () => {
  it('accepts lengths 1..8160 only', async () => {
    const ikm = new Uint8Array(32);
    expect((await hkdfSha256(ikm, ikm, ikm, 1)).length).toBe(1);
    expect((await hkdfSha256(ikm, ikm, ikm, HKDF_SHA256_MAX_LENGTH)).length).toBe(8160);
    for (const length of [0, 1.5, HKDF_SHA256_MAX_LENGTH + 1]) {
      await expect(hkdfSha256(ikm, ikm, ikm, length)).rejects.toEqual(code('invalid_argument'));
    }
  });
});

describe('X25519', () => {
  it('rejects wrong key lengths', async () => {
    const pair = await x25519KeyPairFromPrivateKey(new Uint8Array(32).fill(5));
    await expect(x25519KeyPairFromPrivateKey(new Uint8Array(31))).rejects.toEqual(
      code('invalid_argument'),
    );
    await expect(x25519(pair.privateKey, new Uint8Array(33))).rejects.toEqual(
      code('invalid_argument'),
    );
  });

  it('rejects a low-order public key (all-zero shared secret)', async () => {
    const pair = await x25519KeyPairFromPrivateKey(new Uint8Array(32).fill(5));
    await expect(x25519(pair.privateKey, new Uint8Array(32))).rejects.toEqual(
      code('invalid_argument'),
    );
  });

  it('agrees on a shared secret', async () => {
    const a = await x25519KeyPairFromPrivateKey(new Uint8Array(32).fill(5));
    const b = await x25519KeyPairFromPrivateKey(new Uint8Array(32).fill(6));
    expect(await x25519(a.privateKey, b.publicKey)).toEqual(
      await x25519(b.privateKey, a.publicKey),
    );
  });
});

describe('webCryptoRandom', () => {
  it('fills requests larger than one getRandomValues call', () => {
    const bytes = webCryptoRandom.bytes(70_000);
    expect(bytes.length).toBe(70_000);
    expect(bytes.subarray(65_536).some((byte) => byte !== 0)).toBe(true);
    expect(webCryptoRandom.bytes(0).length).toBe(0);
  });
});
