import { webCryptoBackend } from './backends/web-crypto.js';

/** What an AES-GCM key may be used for. */
export type AesGcmUsage = 'encrypt' | 'decrypt';

/**
 * The raw primitives a platform supplies (ADR 0017). The functions in `primitives/`
 * validate lengths and map failures to `CryptoError`, then call the active backend, so
 * a backend only computes. Keys are `CryptoKey`s: real ones from WebCrypto, opaque
 * look-alikes from the noble backend. Neither backend ever exposes private key bytes.
 */
export interface CryptoBackend {
  /** For diagnostics only. */
  readonly name: string;
  readonly sha256: (data: Uint8Array) => Promise<Uint8Array<ArrayBuffer>>;
  /** `key` is never empty (the caller checks). */
  readonly hmacSha256: (key: Uint8Array, data: Uint8Array) => Promise<Uint8Array<ArrayBuffer>>;
  /** `length` is already checked to be 1..8160. */
  readonly hkdfSha256: (
    ikm: Uint8Array,
    salt: Uint8Array,
    info: Uint8Array,
    length: number,
  ) => Promise<Uint8Array<ArrayBuffer>>;
  /** `raw` is 32 bytes; the key is non-extractable and limited to `usages`. */
  readonly importAesGcmKey: (raw: Uint8Array, usages: readonly AesGcmUsage[]) => Promise<CryptoKey>;
  /** Returns `ciphertext || tag`; refuses a key without the `encrypt` usage. */
  readonly aesGcmEncrypt: (
    key: CryptoKey,
    nonce: Uint8Array,
    aad: Uint8Array,
    plaintext: Uint8Array,
  ) => Promise<Uint8Array<ArrayBuffer>>;
  /** Throws on any authentication failure or a key without the `decrypt` usage. */
  readonly aesGcmDecrypt: (
    key: CryptoKey,
    nonce: Uint8Array,
    aad: Uint8Array,
    ciphertext: Uint8Array,
  ) => Promise<Uint8Array<ArrayBuffer>>;
  /** A 32-byte scalar as a non-extractable X25519 private key. */
  readonly importX25519PrivateKey: (scalar: Uint8Array) => Promise<CryptoKey>;
  /** Throws on a foreign key or a low-order public key (all-zero result). */
  readonly x25519: (
    privateKey: CryptoKey,
    publicKey: Uint8Array,
  ) => Promise<Uint8Array<ArrayBuffer>>;
  /** ECDSA P-256 / SHA-256 over `data` with a raw `r || s` signature; `false` for a bad key. */
  readonly verifyEs256: (
    spki: Uint8Array,
    data: Uint8Array,
    signature: Uint8Array<ArrayBuffer>,
  ) => Promise<boolean>;
}

let active: CryptoBackend = webCryptoBackend;

/**
 * Selects the primitives backend for the whole process. WebCrypto is the default (D3);
 * the React Native app, which has no `crypto.subtle`, calls this once at start-up with
 * `nobleBackend` from `@remote-control/crypto/noble`. Keys from one backend do not work
 * with the other, so select before creating any.
 */
export function setCryptoBackend(backend: CryptoBackend): void {
  active = backend;
}

/** The backend the primitives use. */
export function cryptoBackend(): CryptoBackend {
  return active;
}
