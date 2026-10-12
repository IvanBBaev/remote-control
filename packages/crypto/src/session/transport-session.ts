import { canonicalJson, type Envelope } from '@remote-control/protocol';

import { copyBytes, utf8 } from '../bytes.js';
import { CryptoError } from '../errors.js';
import type { CipherState } from '../noise/cipher-state.js';
import type { HandshakeResult } from '../noise/handshake-state.js';
import { MAX_FRAME_BYTES, pad, unpad } from './padding.js';
import { SerialQueue } from './serial-queue.js';

/** The envelope's routing metadata: everything but the ciphertext (D14). */
export type EnvelopeHeader = Omit<Envelope, 'payload'>;

/** The AEAD associated data for an envelope header: its canonical JSON, UTF-8 (D3). */
export function headerAad(header: EnvelopeHeader): Uint8Array<ArrayBuffer> {
  return utf8(canonicalJson(header));
}

/**
 * An established end-to-end session over one connection (D3):
 * - one CipherState per direction with a strict counter nonce, so a replayed, reordered,
 *   dropped or cross-session frame fails to decrypt (P2, P3);
 * - AAD = canonical header bytes, so the relay cannot re-address or re-sequence a frame
 *   (P1, P4);
 * - plaintexts padded to 256-byte blocks (P5), frames capped at 64 KiB;
 * - rekey on reconnect: a session never outlives its connection. On disconnect the
 *   owner calls {@link close} and runs a fresh handshake (new ephemerals, new keys).
 *
 * Any receive failure closes the session for good (the counter cannot resynchronise);
 * so does reaching the message limit. A closed session rejects every call, including
 * frames already queued, with `session_closed` (revocation).
 */
export class TransportSession {
  readonly #send: CipherState;
  readonly #receive: CipherState;
  readonly #sendQueue = new SerialQueue();
  readonly #receiveQueue = new SerialQueue();
  readonly #handshakeHash: Uint8Array<ArrayBuffer>;
  readonly #remoteStaticPublicKey: Uint8Array<ArrayBuffer> | undefined;
  #closed = false;

  private constructor(result: HandshakeResult) {
    this.#send = result.send;
    this.#receive = result.receive;
    this.#handshakeHash = copyBytes(result.handshakeHash);
    this.#remoteStaticPublicKey = result.remoteStaticPublicKey;
  }

  /** Wraps the CipherStates of a completed handshake. */
  static fromHandshake(result: HandshakeResult): TransportSession {
    return new TransportSession(result);
  }

  /** The handshake hash: a channel binding unique to this session. */
  get handshakeHash(): Uint8Array<ArrayBuffer> {
    return copyBytes(this.#handshakeHash);
  }

  /** The peer's authenticated static public key, when the handshake established one. */
  get remoteStaticPublicKey(): Uint8Array<ArrayBuffer> | undefined {
    return this.#remoteStaticPublicKey && copyBytes(this.#remoteStaticPublicKey);
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Ends the session; every pending and later call rejects with `session_closed`. */
  close(): void {
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) throw new CryptoError('session_closed', 'Transport session is closed');
  }

  /**
   * Encrypts one frame bound to `header`. Frames get consecutive nonces in call order,
   * and the returned promises settle in that order, so the caller sends them as they
   * resolve. Rejects with `frame_too_large` (session stays open) or `nonce_exhausted` (closes).
   */
  async encrypt(header: EnvelopeHeader, plaintext: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    // Runs synchronously, before the queue: a rejected frame reserves no nonce, and the
    // send order is fixed at call time.
    const aad = headerAad(header);
    const padded = pad(plaintext);
    return this.#sendQueue.run(async () => {
      this.#assertOpen();
      try {
        return await this.#send.encryptWithAd(aad, padded);
      } catch (error) {
        this.close();
        throw error;
      }
    });
  }

  /**
   * Decrypts the next frame from the peer, which must carry exactly the `header` it was
   * sent with. Calls are processed in order. Any failure closes the session.
   */
  async decrypt(header: EnvelopeHeader, ciphertext: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    const aad = headerAad(header);
    const frame = copyBytes(ciphertext);
    return this.#receiveQueue.run(async () => {
      this.#assertOpen();
      try {
        if (frame.length > MAX_FRAME_BYTES) {
          throw new CryptoError('frame_too_large', `Frame exceeds ${MAX_FRAME_BYTES} bytes`);
        }
        return unpad(await this.#receive.decryptWithAd(aad, frame));
      } catch (error) {
        this.close();
        throw error;
      }
    });
  }
}
