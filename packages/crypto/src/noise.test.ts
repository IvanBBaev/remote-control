// Unit tests of the Noise state machines beyond the published vectors: option
// validation, turn order, failure latching and size limits.
import { describe, expect, it } from 'vitest';

import { aesGcmNonce, CipherState } from './noise/cipher-state.js';
import {
  HandshakeState,
  type HandshakeOptions,
  NOISE_MAX_MESSAGE_LENGTH,
} from './noise/handshake-state.js';
import { KK, type HandshakePattern, XXPSK0 } from './noise/patterns.js';
import { PROLOGUE, seededRandom, staticKey } from '../test/support.js';

const code = (expected: string) =>
  expect.objectContaining({ name: 'CryptoError', code: expected }) as unknown;

const NN: HandshakePattern = {
  name: 'NN',
  initiatorPreMessage: [],
  responderPreMessage: [],
  messages: [['e'], ['e', 'ee']],
};

async function nnPair(pattern: HandshakePattern = NN) {
  const base = { pattern, prologue: PROLOGUE };
  return {
    initiator: await HandshakeState.initialize({
      ...base,
      initiator: true,
      random: seededRandom(1),
    }),
    responder: await HandshakeState.initialize({
      ...base,
      initiator: false,
      random: seededRandom(2),
    }),
  };
}

describe('CipherState', () => {
  it('validates the message limit', async () => {
    for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(CipherState.create(new Uint8Array(32), limit)).rejects.toEqual(
        code('invalid_argument'),
      );
    }
  });

  it('passes data through without a key and counts nonces with one', async () => {
    const empty = await CipherState.create();
    expect(empty.hasKey()).toBe(false);
    expect(await empty.encryptWithAd(new Uint8Array(0), Uint8Array.of(1))).toEqual(
      Uint8Array.of(1),
    );
    expect(await empty.decryptWithAd(new Uint8Array(0), Uint8Array.of(2))).toEqual(
      Uint8Array.of(2),
    );
    const sender = await CipherState.create(new Uint8Array(32));
    const receiver = await CipherState.create(new Uint8Array(32));
    const ciphertext = await sender.encryptWithAd(new Uint8Array(0), Uint8Array.of(3));
    expect(sender.nonce).toBe(1);
    await expect(receiver.decryptWithAd(Uint8Array.of(1), ciphertext)).rejects.toEqual(
      code('decrypt_failed'),
    );
    expect(receiver.nonce).toBe(0); // a failed decryption does not advance the counter
    expect(await receiver.decryptWithAd(new Uint8Array(0), ciphertext)).toEqual(Uint8Array.of(3));
    expect(receiver.nonce).toBe(1);
  });

  it('encodes the counter as 4 zero bytes and a 64-bit big-endian integer', () => {
    expect(aesGcmNonce(1)).toEqual(Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1));
    expect(aesGcmNonce(2 ** 32 + 2)).toEqual(Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 2));
  });
});

describe('HandshakeState.initialize', () => {
  it('rejects inconsistent options', async () => {
    const phone = await staticKey(1);
    const agent = await staticKey(2);
    const kk: HandshakeOptions = {
      pattern: KK,
      initiator: true,
      prologue: PROLOGUE,
      random: seededRandom(1),
      staticKeyPair: phone,
      remoteStaticPublicKey: agent.publicKey,
    };
    const xx: HandshakeOptions = {
      pattern: XXPSK0,
      initiator: false,
      prologue: PROLOGUE,
      random: seededRandom(1),
      staticKeyPair: agent,
      psk: new Uint8Array(32),
    };
    const invalid: HandshakeOptions[] = [
      { ...kk, staticKeyPair: undefined },
      { ...kk, remoteStaticPublicKey: undefined },
      { ...kk, remoteStaticPublicKey: new Uint8Array(31) },
      { ...kk, psk: new Uint8Array(32) },
      { ...kk, messageLimit: 0 },
      { ...kk, messageLimit: 2.5 },
      { ...xx, staticKeyPair: undefined },
      { ...xx, psk: undefined },
      { ...xx, psk: new Uint8Array(31) },
      { ...xx, remoteStaticPublicKey: phone.publicKey },
    ];
    for (const options of invalid) {
      await expect(HandshakeState.initialize(options)).rejects.toEqual(code('invalid_argument'));
    }
    await expect(HandshakeState.initialize({ ...kk, messageLimit: 1 })).resolves.toBeInstanceOf(
      HandshakeState,
    );
  });

  it('hashes protocol names longer than 32 bytes', async () => {
    const { initiator, responder } = await nnPair({ ...NN, name: 'NN_with_a_rather_long_name' });
    await responder.readMessage(await initiator.writeMessage());
    await initiator.readMessage(await responder.writeMessage());
    expect(initiator.result().handshakeHash).toEqual(responder.result().handshakeHash);
  });
});

describe('HandshakeState messages', () => {
  it('reports progress and only yields a result when complete', async () => {
    const { initiator, responder } = await nnPair();
    expect(initiator.isMyTurnToWrite).toBe(true);
    expect(responder.isMyTurnToWrite).toBe(false);
    expect(() => initiator.result()).toThrow(code('invalid_argument'));
    const payload = await responder.readMessage(await initiator.writeMessage(Uint8Array.of(7)));
    expect(payload).toEqual(Uint8Array.of(7));
    expect(responder.handshakeHash).toEqual(initiator.handshakeHash);
    await initiator.readMessage(await responder.writeMessage());
    expect(initiator.complete).toBe(true);
    expect(initiator.result().remoteStaticPublicKey).toBeUndefined();
  });

  it('fails a message out of turn and stays failed', async () => {
    const { responder } = await nnPair();
    await expect(responder.writeMessage()).rejects.toEqual(code('handshake_failed'));
    await expect(responder.readMessage(new Uint8Array(32))).rejects.toEqual(
      code('handshake_failed'),
    );
  });

  it('fails a message after completion', async () => {
    const { initiator, responder } = await nnPair();
    await responder.readMessage(await initiator.writeMessage());
    await initiator.readMessage(await responder.writeMessage());
    await expect(initiator.writeMessage()).rejects.toEqual(code('handshake_failed'));
  });

  it('fails overlapping calls', async () => {
    const { initiator } = await nnPair();
    const first = initiator.writeMessage();
    await expect(initiator.writeMessage()).rejects.toEqual(code('handshake_failed'));
    await first;
  });

  it('fails a message over 65535 bytes, outgoing or incoming', async () => {
    const { initiator, responder } = await nnPair();
    await expect(
      initiator.writeMessage(new Uint8Array(NOISE_MAX_MESSAGE_LENGTH - 31)),
    ).rejects.toEqual(code('handshake_failed'));
    await expect(
      responder.readMessage(new Uint8Array(NOISE_MAX_MESSAGE_LENGTH + 1)),
    ).rejects.toEqual(code('handshake_failed'));
  });

  it('fails a truncated message', async () => {
    const { initiator, responder } = await nnPair();
    const message = await initiator.writeMessage();
    await expect(responder.readMessage(message.subarray(0, 31))).rejects.toEqual(
      code('handshake_failed'),
    );
  });

  it('fails a pattern that uses a key it never received', async () => {
    const broken: HandshakePattern = { ...NN, messages: [['ee']] };
    const { initiator } = await nnPair(broken);
    await expect(initiator.writeMessage()).rejects.toEqual(
      expect.objectContaining({
        code: 'handshake_failed',
        cause: expect.objectContaining({ code: 'invalid_argument' }) as unknown,
      }),
    );
  });
});
