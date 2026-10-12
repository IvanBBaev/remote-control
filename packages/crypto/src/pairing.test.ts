// Prologues (D3), the pairing fingerprint, the notification key (D5) and padding.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { utf8 } from './bytes.js';
import { pairingFingerprint } from './fingerprint.js';
import { deriveNotificationKey, NOTIFICATION_KEY_INFO } from './notification-key.js';
import { aesGcmDecrypt, aesGcmEncrypt, importAesGcmKey } from './primitives/aes-gcm.js';
import { x25519 } from './primitives/x25519.js';
import { MAX_PADDED_BYTES, pad, PADDING_BLOCK, unpad } from './session/padding.js';
import { pairingPrologue, sessionPrologue } from './session/prologue.js';
import { AGENT, PHONE, staticKey, USER } from '../test/support.js';

const code = (expected: string) =>
  expect.objectContaining({ name: 'CryptoError', code: expected }) as unknown;

describe('prologues (D3)', () => {
  it('concatenates the label and the canonical UUID texts', () => {
    expect(sessionPrologue({ userId: USER, phoneDeviceId: PHONE, agentDeviceId: AGENT })).toEqual(
      utf8(`rc/v1${USER}${PHONE}${AGENT}`),
    );
    expect(pairingPrologue({ userId: USER, agentDeviceId: AGENT })).toEqual(
      utf8(`rc/v1/pair${USER}${AGENT}`),
    );
  });

  it('rejects ids that are not lower-case canonical UUIDs', () => {
    for (const bad of [USER.toUpperCase(), `{${USER}}`, USER.replaceAll('-', ''), '']) {
      expect(() =>
        sessionPrologue({ userId: USER, phoneDeviceId: bad, agentDeviceId: AGENT }),
      ).toThrow(code('invalid_argument'));
      expect(() => pairingPrologue({ userId: bad, agentDeviceId: AGENT })).toThrow(
        code('invalid_argument'),
      );
    }
  });
});

// Independent reference: bit string of SHA-256, first 40 bits, RFC 4648 alphabet.
async function referenceFingerprint(phone: Uint8Array, agent: Uint8Array): Promise<string> {
  const input = new Uint8Array([...phone, ...agent]);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  const bits = Array.from(digest, (byte) => byte.toString(2).padStart(8, '0')).join('');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let text = '';
  for (let i = 0; i < 40; i += 5) text += alphabet[parseInt(bits.slice(i, i + 5), 2)];
  return `${text.slice(0, 4)}-${text.slice(4)}`;
}

describe('pairingFingerprint', () => {
  it('matches an independent base32 computation', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        async (phone, agent) => {
          const fingerprint = await pairingFingerprint(phone, agent);
          expect(fingerprint).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
          expect(fingerprint).toBe(await referenceFingerprint(phone, agent));
        },
      ),
      { numRuns: 50 },
    );
  });

  it('is order-sensitive and checks key lengths', async () => {
    const a = new Uint8Array(32).fill(1);
    const b = new Uint8Array(32).fill(2);
    expect(await pairingFingerprint(a, b)).not.toBe(await pairingFingerprint(b, a));
    await expect(pairingFingerprint(a, new Uint8Array(31))).rejects.toEqual(
      code('invalid_argument'),
    );
    await expect(pairingFingerprint(new Uint8Array(33), b)).rejects.toEqual(
      code('invalid_argument'),
    );
  });
});

describe('deriveNotificationKey (D5)', () => {
  it('gives both ends the same key: HKDF(DH, salt = empty, info = "rc/v1/push")', async () => {
    const phone = await staticKey(1);
    const agent = await staticKey(2);
    const agentKey = await deriveNotificationKey(agent.privateKey, phone.publicKey, ['encrypt']);
    const phoneKey = await deriveNotificationKey(phone.privateKey, agent.publicKey, ['decrypt']);
    const nonce = new Uint8Array(12).fill(9);
    const sealed = await aesGcmEncrypt(agentKey, nonce, new Uint8Array(0), utf8('approve?'));
    expect(await aesGcmDecrypt(phoneKey, nonce, new Uint8Array(0), sealed)).toEqual(
      utf8('approve?'),
    );

    // Recompute the key independently with WebCrypto's own HKDF.
    const dh = await x25519(agent.privateKey, phone.publicKey);
    const ikm = await crypto.subtle.importKey('raw', dh, 'HKDF', false, ['deriveBits']);
    const raw = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(NOTIFICATION_KEY_INFO) },
      ikm,
      256,
    );
    const reference = await importAesGcmKey(new Uint8Array(raw));
    expect(await aesGcmDecrypt(reference, nonce, new Uint8Array(0), sealed)).toEqual(
      utf8('approve?'),
    );
  });

  it('produces a non-extractable key limited to its usages', async () => {
    const phone = await staticKey(1);
    const agent = await staticKey(2);
    const key = await deriveNotificationKey(phone.privateKey, agent.publicKey, ['decrypt']);
    expect(key.extractable).toBe(false);
    expect(key.usages).toEqual(['decrypt']);
    await expect(
      aesGcmEncrypt(key, new Uint8Array(12), new Uint8Array(0), utf8('x')),
    ).rejects.toThrow();
  });

  it('differs per pairing', async () => {
    const phone = await staticKey(1);
    const key = await deriveNotificationKey(phone.privateKey, (await staticKey(2)).publicKey, [
      'encrypt',
    ]);
    const other = await deriveNotificationKey(phone.privateKey, (await staticKey(3)).publicKey, [
      'decrypt',
    ]);
    const nonce = new Uint8Array(12);
    const sealed = await aesGcmEncrypt(key, nonce, new Uint8Array(0), utf8('x'));
    await expect(aesGcmDecrypt(other, nonce, new Uint8Array(0), sealed)).rejects.toEqual(
      code('decrypt_failed'),
    );
  });
});

describe('padding', () => {
  it('round-trips and always fills whole blocks', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 1500 }), (plaintext) => {
        const padded = pad(plaintext);
        expect(padded.length % PADDING_BLOCK).toBe(0);
        expect(padded.length - plaintext.length - 4).toBeLessThan(PADDING_BLOCK);
        expect(unpad(padded)).toEqual(plaintext);
      }),
    );
  });

  it('rejects malformed padding', () => {
    const withLength = (size: number, length: number): Uint8Array => {
      const out = new Uint8Array(size);
      new DataView(out.buffer).setUint32(0, length);
      return out;
    };
    const malformed = [
      new Uint8Array(0),
      new Uint8Array(255),
      new Uint8Array(MAX_PADDED_BYTES + PADDING_BLOCK),
      withLength(256, 253), // length runs past the end
      withLength(512, 10), // more than one block of fill
    ];
    const dirty = withLength(256, 3);
    dirty[200] = 1;
    malformed.push(dirty);
    for (const padded of malformed) {
      expect(() => unpad(padded)).toThrow(code('decrypt_failed'));
    }
  });
});
