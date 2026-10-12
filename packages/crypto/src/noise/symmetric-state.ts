import { concatBytes, utf8 } from '../bytes.js';
import { sha256, SHA256_LENGTH } from '../primitives/sha256.js';
import { CipherState } from './cipher-state.js';
import { noiseHkdf } from './noise-hkdf.js';

/** Noise `SymmetricState` (Noise §5.2) for `SHA256`: chaining key, hash and a CipherState. */
export class SymmetricState {
  #ck: Uint8Array<ArrayBuffer>;
  #h: Uint8Array<ArrayBuffer>;
  #cipher: CipherState;

  private constructor(h: Uint8Array<ArrayBuffer>, cipher: CipherState) {
    this.#h = h;
    this.#ck = h;
    this.#cipher = cipher;
  }

  /** Noise `InitializeSymmetric(protocol_name)`. */
  static async initialize(protocolName: string): Promise<SymmetricState> {
    const name = utf8(protocolName);
    const h =
      name.length <= SHA256_LENGTH
        ? concatBytes(name, new Uint8Array(SHA256_LENGTH - name.length))
        : await sha256(name);
    return new SymmetricState(h, await CipherState.create());
  }

  /** The handshake hash `h`. */
  get handshakeHash(): Uint8Array<ArrayBuffer> {
    return this.#h;
  }

  hasKey(): boolean {
    return this.#cipher.hasKey();
  }

  async mixHash(data: Uint8Array): Promise<void> {
    this.#h = await sha256(concatBytes(this.#h, data));
  }

  async mixKey(inputKeyMaterial: Uint8Array): Promise<void> {
    const [ck, tempK] = (await noiseHkdf(this.#ck, inputKeyMaterial, 2)) as [
      Uint8Array<ArrayBuffer>,
      Uint8Array<ArrayBuffer>,
    ];
    this.#ck = ck;
    this.#cipher = await CipherState.create(tempK);
  }

  async mixKeyAndHash(inputKeyMaterial: Uint8Array): Promise<void> {
    const [ck, tempH, tempK] = (await noiseHkdf(this.#ck, inputKeyMaterial, 3)) as [
      Uint8Array<ArrayBuffer>,
      Uint8Array<ArrayBuffer>,
      Uint8Array<ArrayBuffer>,
    ];
    this.#ck = ck;
    await this.mixHash(tempH);
    this.#cipher = await CipherState.create(tempK);
  }

  async encryptAndHash(plaintext: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    const ciphertext = await this.#cipher.encryptWithAd(this.#h, plaintext);
    await this.mixHash(ciphertext);
    return ciphertext;
  }

  async decryptAndHash(ciphertext: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    const plaintext = await this.#cipher.decryptWithAd(this.#h, ciphertext);
    await this.mixHash(ciphertext);
    return plaintext;
  }

  /** Noise `Split()`: the initiator→responder and responder→initiator CipherStates. */
  async split(messageLimit: number): Promise<[CipherState, CipherState]> {
    const [k1, k2] = (await noiseHkdf(this.#ck, new Uint8Array(0), 2)) as [
      Uint8Array<ArrayBuffer>,
      Uint8Array<ArrayBuffer>,
    ];
    return [await CipherState.create(k1, messageLimit), await CipherState.create(k2, messageLimit)];
  }
}
