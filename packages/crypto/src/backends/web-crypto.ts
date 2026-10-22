import type { CryptoBackend } from '../backend.js';
import { concatBytes, copyBytes, fromHex } from '../bytes.js';
import { getSubtle } from '../primitives/subtle.js';

// PKCS#8 wrapping of a raw X25519 private key (RFC 8410): WebCrypto imports X25519
// private keys only as PKCS#8 or JWK.
const PKCS8_PREFIX = fromHex('302e020100300506032b656e04220420');
const X25519 = { name: 'X25519' };

/** The default backend: the platform's WebCrypto, in Node 22 and in the browser (D3). */
export const webCryptoBackend: CryptoBackend = {
  name: 'webcrypto',

  sha256: async (data) => new Uint8Array(await getSubtle().digest('SHA-256', copyBytes(data))),

  hmacSha256: async (key, data) => {
    const subtle = getSubtle();
    const hmacKey = await subtle.importKey(
      'raw',
      copyBytes(key),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    return new Uint8Array(await subtle.sign('HMAC', hmacKey, copyBytes(data)));
  },

  hkdfSha256: async (ikm, salt, info, length) => {
    const subtle = getSubtle();
    const key = await subtle.importKey('raw', copyBytes(ikm), 'HKDF', false, ['deriveBits']);
    const bits = await subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: copyBytes(salt), info: copyBytes(info) },
      key,
      length * 8,
    );
    return new Uint8Array(bits);
  },

  importAesGcmKey: (raw, usages) =>
    getSubtle().importKey('raw', copyBytes(raw), { name: 'AES-GCM' }, false, [...usages]),

  aesGcmEncrypt: async (key, nonce, aad, plaintext) => {
    const params = { name: 'AES-GCM', iv: copyBytes(nonce), additionalData: copyBytes(aad) };
    return new Uint8Array(await getSubtle().encrypt(params, key, copyBytes(plaintext)));
  },

  aesGcmDecrypt: async (key, nonce, aad, ciphertext) => {
    const params = { name: 'AES-GCM', iv: copyBytes(nonce), additionalData: copyBytes(aad) };
    return new Uint8Array(await getSubtle().decrypt(params, key, copyBytes(ciphertext)));
  },

  importX25519PrivateKey: (secret) => {
    // WebKitGTK/WPE (Linux WebKit) rejects a PKCS#8 key whose first byte is 0x00 with a
    // DataError, i.e. 1 in 256 keys. Clamping (RFC 7748 §5) clears the low three bits of
    // that byte, so 0x01 yields the same scalar and the same key, and the key never leaves
    // WebCrypto as bytes.
    const scalar = copyBytes(secret);
    if (scalar[0] === 0) scalar[0] = 1;
    return getSubtle().importKey('pkcs8', concatBytes(PKCS8_PREFIX, scalar), X25519, false, [
      'deriveBits',
    ]);
  },

  x25519: async (privateKey, publicKey) => {
    const subtle = getSubtle();
    const peer = await subtle.importKey('raw', copyBytes(publicKey), X25519, true, []);
    const bits = await subtle.deriveBits({ name: 'X25519', public: peer }, privateKey, 256);
    return new Uint8Array(bits);
  },

  verifyEs256: async (spki, data, signature) => {
    const subtle = getSubtle();
    let key: CryptoKey;
    try {
      key = await subtle.importKey(
        'spki',
        copyBytes(spki),
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
    } catch {
      return false;
    }
    return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, copyBytes(data));
  },
};
