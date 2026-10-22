// Unit tests of the byte helpers, the primitives on both backends, the capability probe
// and the randomness adapter. Browser-safe: no `node:*` imports.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { webCryptoRandom } from './adapters/web-crypto-random.js';
import { cryptoBackend, setCryptoBackend } from './backend.js';
import { nobleBackend } from './backends/noble.js';
import { webCryptoBackend } from './backends/web-crypto.js';
import { bytesEqual, concatBytes, fromHex, utf8 } from './bytes.js';
import { CryptoError } from './errors.js';
import { es256DerToRaw, verifyEs256 } from './primitives/ecdsa.js';
import { aesGcmDecrypt, aesGcmEncrypt, importAesGcmKey } from './primitives/aes-gcm.js';
import { hkdfSha256, HKDF_SHA256_MAX_LENGTH } from './primitives/hkdf.js';
import { hmacSha256 } from './primitives/hmac.js';
import { probeWebCrypto } from './primitives/probe.js';
import { getSubtle } from './primitives/subtle.js';
import { x25519, x25519KeyPairFromPrivateKey } from './primitives/x25519.js';

const code = (expected: string) =>
  expect.objectContaining({ name: 'CryptoError', code: expected }) as unknown;

afterEach(() => {
  vi.unstubAllGlobals();
  setCryptoBackend(webCryptoBackend);
});

const BACKENDS = [webCryptoBackend, nobleBackend];

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

describe.each(BACKENDS)('$name primitives', (backend) => {
  beforeEach(() => {
    setCryptoBackend(backend);
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

  it('computes HMAC-SHA-256 (RFC 4231 case 2) and refuses an empty key', async () => {
    expect(await hmacSha256(utf8('Jefe'), utf8('what do ya want for nothing?'))).toEqual(
      fromHex('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'),
    );
    await expect(hmacSha256(new Uint8Array(0), utf8('x'))).rejects.toEqual(
      code('invalid_argument'),
    );
  });

  it('derives the same X25519 public key as the other backend, first byte 0 included', async () => {
    for (const secret of [
      new Uint8Array(32).fill(5),
      Uint8Array.of(0, ...new Uint8Array(31).fill(7)),
    ]) {
      const own = await x25519KeyPairFromPrivateKey(secret);
      setCryptoBackend(backend === nobleBackend ? webCryptoBackend : nobleBackend);
      const other = await x25519KeyPairFromPrivateKey(secret);
      setCryptoBackend(backend);
      expect(own.publicKey).toEqual(other.publicKey);
    }
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

/** WebCrypto gives `r || s`; WebAuthn carries DER. Minimal integers, short-form lengths. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array): number[] => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    const trimmed = [...bytes.subarray(start)];
    if (trimmed[0]! & 0x80) trimmed.unshift(0);
    return [0x02, trimmed.length, ...trimmed];
  };
  const body = [...integer(raw.subarray(0, 32)), ...integer(raw.subarray(32))];
  return Uint8Array.from([0x30, body.length, ...body]);
}

describe.each(BACKENDS)('$name ES256', (backend) => {
  beforeEach(() => {
    setCryptoBackend(backend);
  });

  async function signed(data: Uint8Array) {
    const subtle = getSubtle();
    const keys = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const spki = new Uint8Array(await subtle.exportKey('spki', keys.publicKey));
    const raw = new Uint8Array(
      await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, Uint8Array.from(data)),
    );
    return { spki, raw, der: rawToDer(raw) };
  }

  it('verifies a DER signature over the data with an SPKI key', async () => {
    const data = utf8('authenticatorData || sha256(clientDataJSON)');
    const { spki, der } = await signed(data);
    await expect(verifyEs256(spki, data, der)).resolves.toBe(true);
  });

  it('refuses other data, a flipped signature byte and a foreign key', async () => {
    const data = utf8('signed');
    const { spki, der } = await signed(data);
    const other = await signed(data);
    await expect(verifyEs256(spki, utf8('Signed'), der)).resolves.toBe(false);
    const flipped = Uint8Array.from(der);
    flipped[flipped.length - 1]! ^= 0x01;
    await expect(verifyEs256(spki, data, flipped)).resolves.toBe(false);
    await expect(verifyEs256(other.spki, data, der)).resolves.toBe(false);
  });

  it('is false for a malformed key or signature, never an exception', async () => {
    const data = utf8('signed');
    const { spki, der, raw } = await signed(data);
    await expect(verifyEs256(Uint8Array.of(1, 2, 3), data, der)).resolves.toBe(false);
    await expect(verifyEs256(spki, data, raw)).resolves.toBe(false);
    await expect(verifyEs256(spki, data, new Uint8Array(0))).resolves.toBe(false);
    // The right length with another curve's prefix, and a point that is not on the curve.
    const otherCurve = Uint8Array.from(spki);
    otherCurve[25] = 0x08;
    await expect(verifyEs256(otherCurve, data, der)).resolves.toBe(false);
    const offCurve = Uint8Array.from(spki);
    offCurve[offCurve.length - 1]! ^= 0x01;
    await expect(verifyEs256(offCurve, data, der)).resolves.toBe(false);
  });

  it('accepts a high-S signature, as WebCrypto does', async () => {
    const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
    const data = utf8('malleable');
    const { spki, raw } = await signed(data);
    const s = BigInt(
      `0x${[...raw.subarray(32)].map((b) => b.toString(16).padStart(2, '0')).join('')}`,
    );
    const flipped = fromHex((n - s).toString(16).padStart(64, '0'));
    const other = concatBytes(raw.subarray(0, 32), flipped);
    await expect(verifyEs256(spki, data, rawToDer(other))).resolves.toBe(true);
  });
});

describe('es256DerToRaw', () => {
  it('converts strict DER to r || s and rejects the rest', () => {
    const r = new Uint8Array(32).fill(0x11);
    const s = new Uint8Array(32).fill(0x22);
    s[0] = 0x80;
    const raw = concatBytes(r, s);
    const der = rawToDer(raw);
    expect(es256DerToRaw(der)).toEqual(raw);
    // Short integers are left-padded.
    expect(es256DerToRaw(Uint8Array.of(0x30, 6, 0x02, 1, 5, 0x02, 1, 7))).toEqual(
      concatBytes(new Uint8Array(31), Uint8Array.of(5), new Uint8Array(31), Uint8Array.of(7)),
    );
    // Trailing byte, wrong sequence length, a negative and a non-minimal integer.
    expect(es256DerToRaw(concatBytes(der, Uint8Array.of(0)))).toBeUndefined();
    expect(es256DerToRaw(Uint8Array.of(0x30, 7, 0x02, 1, 5, 0x02, 1, 7))).toBeUndefined();
    expect(es256DerToRaw(Uint8Array.of(0x30, 6, 0x02, 1, 0x85, 0x02, 1, 7))).toBeUndefined();
    expect(es256DerToRaw(Uint8Array.of(0x30, 7, 0x02, 2, 0, 5, 0x02, 1, 7))).toBeUndefined();
    // An integer longer than a P-256 scalar.
    const long = Uint8Array.of(0x30, 38, 0x02, 33, 1, ...new Uint8Array(32), 0x02, 1, 7);
    expect(es256DerToRaw(long)).toBeUndefined();
    // Not a sequence, a long-form sequence length, and truncated input.
    expect(es256DerToRaw(new Uint8Array(0))).toBeUndefined();
    expect(es256DerToRaw(Uint8Array.of(0x31, 6, 0x02, 1, 5, 0x02, 1, 7))).toBeUndefined();
    expect(es256DerToRaw(Uint8Array.of(0x30, 0x81, 6))).toBeUndefined();
    expect(es256DerToRaw(Uint8Array.of(0x30, 1, 0x02))).toBeUndefined();
    // Integers: wrong tag, zero, long-form and overlong lengths, a lone zero byte.
    expect(es256DerToRaw(Uint8Array.of(0x30, 6, 0x03, 1, 5, 0x02, 1, 7))).toBeUndefined();
    expect(es256DerToRaw(Uint8Array.of(0x30, 5, 0x02, 0, 0x02, 1, 7))).toBeUndefined();
    expect(es256DerToRaw(Uint8Array.of(0x30, 6, 0x02, 0x81, 5, 0x02, 1, 7))).toBeUndefined();
    expect(es256DerToRaw(Uint8Array.of(0x30, 6, 0x02, 1, 5, 0x02, 2, 7))).toBeUndefined();
    expect(es256DerToRaw(Uint8Array.of(0x30, 6, 0x02, 1, 0, 0x02, 1, 7))).toBeUndefined();
  });
});

describe('backend selection', () => {
  it('defaults to WebCrypto and switches', () => {
    expect(cryptoBackend()).toBe(webCryptoBackend);
    setCryptoBackend(nobleBackend);
    expect(cryptoBackend().name).toBe('noble');
  });
});

describe('noble backend', () => {
  beforeEach(() => {
    setCryptoBackend(nobleBackend);
  });

  it('are opaque, frozen CryptoKey look-alikes', async () => {
    const key = await importAesGcmKey(new Uint8Array(32), ['encrypt']);
    expect(key).toMatchObject({
      algorithm: { name: 'AES-GCM' },
      extractable: false,
      type: 'secret',
      usages: ['encrypt'],
    });
    expect(Object.isFrozen(key)).toBe(true);
    expect(Object.values(key).some((value) => value instanceof Uint8Array)).toBe(false);
  });

  it('refuses a key of another backend, another algorithm or without the usage', async () => {
    const nonce = new Uint8Array(12);
    const ciphertext = new Uint8Array(16);
    const encryptOnly = await importAesGcmKey(new Uint8Array(32), ['encrypt']);
    await expect(aesGcmDecrypt(encryptOnly, nonce, utf8(''), ciphertext)).rejects.toEqual(
      code('decrypt_failed'),
    );
    const pair = await x25519KeyPairFromPrivateKey(new Uint8Array(32).fill(5));
    await expect(aesGcmEncrypt(pair.privateKey, nonce, utf8(''), utf8('x'))).rejects.toEqual(
      code('invalid_argument'),
    );
    setCryptoBackend(webCryptoBackend);
    const foreign = await x25519KeyPairFromPrivateKey(new Uint8Array(32).fill(5));
    setCryptoBackend(nobleBackend);
    await expect(x25519(foreign.privateKey, pair.publicKey)).rejects.toEqual(
      code('invalid_argument'),
    );
  });

  it('verifies to false, not a throw, for a signature of the wrong length', async () => {
    const spki = fromHex(
      `3059301306072a8648ce3d020106082a8648ce3d030107034200${'04'.padEnd(130, '0')}`,
    );
    await expect(nobleBackend.verifyEs256(spki, utf8('x'), new Uint8Array(63))).resolves.toBe(
      false,
    );
  });
});
