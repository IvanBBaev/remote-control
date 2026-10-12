import { copyBytes } from '../bytes.js';
import { CryptoError } from '../errors.js';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  AES_GCM_NONCE_LENGTH,
  importAesGcmKey,
} from '../primitives/aes-gcm.js';

/**
 * Messages per direction before a session must re-handshake. Far below Noise's 2^64 − 1
 * and below the AES-GCM per-key bound; reconnects re-handshake long before it in practice.
 */
export const DEFAULT_MESSAGE_LIMIT = 2 ** 32;

/** Noise AESGCM nonce: 32 bits of zeros followed by the big-endian 64-bit counter. */
export function aesGcmNonce(counter: number): Uint8Array<ArrayBuffer> {
  const nonce = new Uint8Array(AES_GCM_NONCE_LENGTH);
  const view = new DataView(nonce.buffer);
  view.setUint32(4, Math.floor(counter / 2 ** 32));
  view.setUint32(8, counter >>> 0);
  return nonce;
}

/**
 * Noise `CipherState` for `AESGCM`: a key and a strictly increasing counter nonce. With
 * no key it passes data through unchanged (Noise §5.1).
 *
 * `encryptWithAd` reserves its nonce synchronously, so concurrent calls never reuse one.
 * `decryptWithAd` advances the counter only on success (Noise §5.1); callers must not
 * overlap decryptions — {@link TransportSession} serialises them.
 */
export class CipherState {
  readonly #key: CryptoKey | undefined;
  readonly #limit: number;
  #n = 0;

  private constructor(key: CryptoKey | undefined, limit: number) {
    this.#key = key;
    this.#limit = limit;
  }

  /** A `CipherState` keyed with 32 raw bytes, or an empty one when `rawKey` is absent. */
  static async create(
    rawKey?: Uint8Array,
    limit: number = DEFAULT_MESSAGE_LIMIT,
  ): Promise<CipherState> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new CryptoError('invalid_argument', 'CipherState: limit must be a positive integer');
    }
    const key = rawKey === undefined ? undefined : await importAesGcmKey(rawKey);
    return new CipherState(key, limit);
  }

  /** Whether a key is set (Noise `HasKey`). */
  hasKey(): boolean {
    return this.#key !== undefined;
  }

  /** The next nonce this state will use. */
  get nonce(): number {
    return this.#n;
  }

  #reserve(): number {
    if (this.#n >= this.#limit) {
      throw new CryptoError('nonce_exhausted', 'Message limit reached; re-handshake required');
    }
    return this.#n;
  }

  async encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    if (this.#key === undefined) return copyBytes(plaintext);
    const n = this.#reserve();
    this.#n = n + 1;
    return aesGcmEncrypt(this.#key, aesGcmNonce(n), ad, plaintext);
  }

  async decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    if (this.#key === undefined) return copyBytes(ciphertext);
    const n = this.#reserve();
    const plaintext = await aesGcmDecrypt(this.#key, aesGcmNonce(n), ad, ciphertext);
    this.#n = n + 1;
    return plaintext;
  }
}
