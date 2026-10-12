import type { Random } from '@remote-control/protocol';

import { concatBytes, copyBytes } from '../bytes.js';
import { CryptoError } from '../errors.js';
import { AES_GCM_TAG_LENGTH } from '../primitives/aes-gcm.js';
import {
  generateX25519KeyPair,
  x25519,
  X25519_KEY_LENGTH,
  type X25519KeyPair,
} from '../primitives/x25519.js';
import { type CipherState, DEFAULT_MESSAGE_LIMIT } from './cipher-state.js';
import { type HandshakePattern, protocolName, type Token } from './patterns.js';
import { SymmetricState } from './symmetric-state.js';

/** Largest Noise message, handshake or transport (Noise §3). */
export const NOISE_MAX_MESSAGE_LENGTH = 65_535;
/** PSK length (Noise §9). */
export const PSK_LENGTH = 32;

/** Options for {@link HandshakeState.initialize}. */
export interface HandshakeOptions {
  readonly pattern: HandshakePattern;
  readonly initiator: boolean;
  /** Bound into the handshake hash; both sides must pass identical bytes. */
  readonly prologue: Uint8Array;
  /** Source of ephemeral private keys (the `Random` port; fixed in vector tests). */
  readonly random: Random;
  /** Own static key pair; required when the pattern uses it. */
  readonly staticKeyPair?: X25519KeyPair;
  /** The peer's static public key; required iff the peer's pre-message carries `s`. */
  readonly remoteStaticPublicKey?: Uint8Array;
  /** 32-byte pre-shared key; required iff the pattern has a `psk` token. */
  readonly psk?: Uint8Array;
  /** Transport messages per direction before {@link CipherState} refuses to encrypt. */
  readonly messageLimit?: number;
}

/** The outcome of a completed handshake (Noise `Split()`, oriented for this side). */
export interface HandshakeResult {
  /** Encrypts what this side sends. */
  readonly send: CipherState;
  /** Decrypts what this side receives. */
  readonly receive: CipherState;
  /** The final handshake hash `h`; a channel binding unique to this handshake. */
  readonly handshakeHash: Uint8Array<ArrayBuffer>;
  /** The authenticated peer static key, when the pattern transmits or pre-shares one. */
  readonly remoteStaticPublicKey: Uint8Array<ArrayBuffer> | undefined;
}

type Phase = 'ready' | 'busy' | 'failed' | 'complete';

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new CryptoError('invalid_argument', `Handshake pattern needs ${what}, which is missing`);
  }
  return value;
}

function sendsToken(pattern: HandshakePattern, initiator: boolean, token: Token): boolean {
  return pattern.messages.some(
    (tokens, index) => index % 2 === (initiator ? 0 : 1) && tokens.includes(token),
  );
}

/**
 * Noise `HandshakeState` (Noise §5.3) for `25519_AESGCM_SHA256`. One instance runs one
 * handshake for one side. Any failure — a malformed or unauthenticated message, a
 * low-order key, a message out of turn — moves it to a terminal failed state; every later
 * call throws `handshake_failed`. Calls must not overlap.
 */
export class HandshakeState {
  readonly #pattern: HandshakePattern;
  readonly #initiator: boolean;
  readonly #random: Random;
  readonly #psk: Uint8Array | undefined;
  readonly #pskMode: boolean;
  readonly #messageLimit: number;
  readonly #symmetric: SymmetricState;
  readonly #s: X25519KeyPair | undefined;
  #e: X25519KeyPair | undefined;
  #rs: Uint8Array<ArrayBuffer> | undefined;
  #re: Uint8Array<ArrayBuffer> | undefined;
  #index = 0;
  #phase: Phase = 'ready';
  #result: HandshakeResult | undefined;

  private constructor(options: HandshakeOptions, symmetric: SymmetricState, pskMode: boolean) {
    this.#pattern = options.pattern;
    this.#initiator = options.initiator;
    this.#random = options.random;
    this.#psk = options.psk;
    this.#pskMode = pskMode;
    this.#messageLimit = options.messageLimit ?? DEFAULT_MESSAGE_LIMIT;
    this.#symmetric = symmetric;
    this.#s = options.staticKeyPair;
    this.#rs = options.remoteStaticPublicKey && copyBytes(options.remoteStaticPublicKey);
  }

  /** Noise `Initialize()`: validates the options and hashes prologue and pre-messages. */
  static async initialize(options: HandshakeOptions): Promise<HandshakeState> {
    const { pattern, initiator, psk, remoteStaticPublicKey, staticKeyPair } = options;
    const own = initiator ? pattern.initiatorPreMessage : pattern.responderPreMessage;
    const peer = initiator ? pattern.responderPreMessage : pattern.initiatorPreMessage;
    const pskMode = pattern.messages.some((tokens) => tokens.includes('psk'));
    if ((own.includes('s') || sendsToken(pattern, initiator, 's')) && staticKeyPair === undefined) {
      throw new CryptoError('invalid_argument', 'Handshake: staticKeyPair is required');
    }
    if (peer.includes('s') !== (remoteStaticPublicKey !== undefined)) {
      throw new CryptoError(
        'invalid_argument',
        'Handshake: remoteStaticPublicKey is required iff the peer pre-shares its static key',
      );
    }
    if (remoteStaticPublicKey !== undefined && remoteStaticPublicKey.length !== X25519_KEY_LENGTH) {
      throw new CryptoError(
        'invalid_argument',
        'Handshake: remoteStaticPublicKey must be 32 bytes',
      );
    }
    if (pskMode !== (psk !== undefined) || (psk !== undefined && psk.length !== PSK_LENGTH)) {
      throw new CryptoError(
        'invalid_argument',
        'Handshake: a 32-byte psk is required iff the pattern has a psk token',
      );
    }
    if (
      options.messageLimit !== undefined &&
      (!Number.isSafeInteger(options.messageLimit) || options.messageLimit < 1)
    ) {
      throw new CryptoError('invalid_argument', 'Handshake: messageLimit must be positive');
    }

    const symmetric = await SymmetricState.initialize(protocolName(pattern));
    await symmetric.mixHash(options.prologue);
    const state = new HandshakeState(options, symmetric, pskMode);
    // Pre-messages: the initiator's keys are hashed first (Noise §5.3).
    for (const initiatorSide of [true, false]) {
      const tokens = initiatorSide ? pattern.initiatorPreMessage : pattern.responderPreMessage;
      // Every pre-message token is `s` (the type allows nothing else).
      for (let i = 0; i < tokens.length; i++) {
        await symmetric.mixHash(state.#staticPublicKey(initiatorSide === initiator));
      }
    }
    return state;
  }

  #staticPublicKey(local: boolean): Uint8Array {
    return local ? required(this.#s, 'a local static key').publicKey : required(this.#rs, 'rs');
  }

  /** Whether the handshake finished; {@link result} is then available. */
  get complete(): boolean {
    return this.#phase === 'complete';
  }

  /** Whether it is this side's turn to write (as opposed to read) the next message. */
  get isMyTurnToWrite(): boolean {
    return this.#index % 2 === (this.#initiator ? 0 : 1);
  }

  /** The handshake hash so far (final once {@link complete}). */
  get handshakeHash(): Uint8Array<ArrayBuffer> {
    return copyBytes(this.#symmetric.handshakeHash);
  }

  /** The peer's static key once known (pre-shared, or received and authenticated). */
  get remoteStaticPublicKey(): Uint8Array<ArrayBuffer> | undefined {
    return this.#rs && copyBytes(this.#rs);
  }

  /** The transport CipherStates; throws until the handshake is complete. */
  result(): HandshakeResult {
    if (this.#result === undefined) {
      throw new CryptoError('invalid_argument', 'Handshake is not complete');
    }
    return this.#result;
  }

  #begin(write: boolean): readonly Token[] {
    if (this.#phase === 'failed') {
      throw new CryptoError('handshake_failed', 'Handshake already failed');
    }
    const tokens = this.#pattern.messages[this.#index];
    if (this.#phase !== 'ready' || tokens === undefined || this.isMyTurnToWrite !== write) {
      this.#phase = 'failed';
      throw new CryptoError('handshake_failed', 'Handshake message out of turn');
    }
    this.#phase = 'busy';
    return tokens;
  }

  async #finish(): Promise<void> {
    this.#index += 1;
    if (this.#index < this.#pattern.messages.length) {
      this.#phase = 'ready';
      return;
    }
    const [c1, c2] = await this.#symmetric.split(this.#messageLimit);
    this.#result = {
      send: this.#initiator ? c1 : c2,
      receive: this.#initiator ? c2 : c1,
      handshakeHash: copyBytes(this.#symmetric.handshakeHash),
      remoteStaticPublicKey: this.remoteStaticPublicKey,
    };
    this.#phase = 'complete';
  }

  async #fail<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      this.#phase = 'failed';
      if (error instanceof CryptoError && error.code === 'handshake_failed') throw error;
      throw new CryptoError('handshake_failed', 'Handshake failed', { cause: error });
    }
  }

  async #dh(token: 'ee' | 'es' | 'se' | 'ss'): Promise<void> {
    // `es` = DH(initiator e, responder s); `se` = DH(initiator s, responder e).
    const initiatorKey = token[0] === 'e' ? 'e' : 's';
    const responderKey = token[1] === 'e' ? 'e' : 's';
    const localKind = this.#initiator ? initiatorKey : responderKey;
    const remoteKind = this.#initiator ? responderKey : initiatorKey;
    const local = required(localKind === 'e' ? this.#e : this.#s, `a local ${localKind} key`);
    const remote = required(remoteKind === 'e' ? this.#re : this.#rs, `a remote ${remoteKind} key`);
    await this.#symmetric.mixKey(await x25519(local.privateKey, remote));
  }

  /** Noise `WriteMessage(payload)`: the next handshake message for the peer. */
  async writeMessage(payload: Uint8Array = new Uint8Array(0)): Promise<Uint8Array<ArrayBuffer>> {
    const tokens = this.#begin(true);
    return this.#fail(async () => {
      const parts: Uint8Array[] = [];
      for (const token of tokens) {
        if (token === 'e') {
          this.#e = await generateX25519KeyPair(this.#random);
          parts.push(this.#e.publicKey);
          await this.#symmetric.mixHash(this.#e.publicKey);
          if (this.#pskMode) await this.#symmetric.mixKey(this.#e.publicKey);
        } else if (token === 's') {
          const s = required(this.#s, 'a local static key');
          parts.push(await this.#symmetric.encryptAndHash(s.publicKey));
        } else if (token === 'psk') {
          await this.#symmetric.mixKeyAndHash(required(this.#psk, 'a psk'));
        } else {
          await this.#dh(token);
        }
      }
      parts.push(await this.#symmetric.encryptAndHash(payload));
      const message = concatBytes(...parts);
      if (message.length > NOISE_MAX_MESSAGE_LENGTH) {
        throw new CryptoError('frame_too_large', 'Handshake message exceeds 65535 bytes');
      }
      await this.#finish();
      return message;
    });
  }

  /** Noise `ReadMessage(message)`: processes the peer's message, returns its payload. */
  async readMessage(message: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    const tokens = this.#begin(false);
    return this.#fail(async () => {
      if (message.length > NOISE_MAX_MESSAGE_LENGTH) {
        throw new CryptoError('handshake_failed', 'Handshake message exceeds 65535 bytes');
      }
      let offset = 0;
      const take = (length: number): Uint8Array<ArrayBuffer> => {
        if (message.length - offset < length) {
          throw new CryptoError('handshake_failed', 'Handshake message truncated');
        }
        offset += length;
        return message.slice(offset - length, offset);
      };
      for (const token of tokens) {
        if (token === 'e') {
          this.#re = take(X25519_KEY_LENGTH);
          await this.#symmetric.mixHash(this.#re);
          if (this.#pskMode) await this.#symmetric.mixKey(this.#re);
        } else if (token === 's') {
          const length = X25519_KEY_LENGTH + (this.#symmetric.hasKey() ? AES_GCM_TAG_LENGTH : 0);
          this.#rs = await this.#symmetric.decryptAndHash(take(length));
        } else if (token === 'psk') {
          await this.#symmetric.mixKeyAndHash(required(this.#psk, 'a psk'));
        } else {
          await this.#dh(token);
        }
      }
      const payload = await this.#symmetric.decryptAndHash(message.slice(offset));
      await this.#finish();
      return payload;
    });
  }
}
