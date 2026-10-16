// Known-answer tests. Browser-safe on purpose (07 W9): no `node:*` imports, the fixture
// loads through a plain JSON import, so the same file runs in Chromium and WebKit.
import { describe, expect, it } from 'vitest';

import fixture from '../fixtures/noise-vectors.json' with { type: 'json' };
import { fromHex } from './bytes.js';
import {
  HandshakeState,
  hkdfSha256,
  KK,
  protocolName,
  x25519,
  x25519KeyPairFromPrivateKey,
  XXPSK0,
  type HandshakePattern,
  type X25519KeyPair,
} from './index.js';

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

describe('RFC 7748 §6.1 (X25519)', () => {
  const alicePrivate = '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a';
  const alicePublic = '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a';
  const bobPrivate = '5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb';
  const bobPublic = 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f';
  const shared = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742';

  it('derives both public keys and the shared secret', async () => {
    const alice = await x25519KeyPairFromPrivateKey(fromHex(alicePrivate));
    const bob = await x25519KeyPairFromPrivateKey(fromHex(bobPrivate));
    expect(hex(alice.publicKey)).toBe(alicePublic);
    expect(hex(bob.publicKey)).toBe(bobPublic);
    expect(hex(await x25519(alice.privateKey, bob.publicKey))).toBe(shared);
    expect(hex(await x25519(bob.privateKey, alice.publicKey))).toBe(shared);
  });

  it('accepts a private key whose first byte is zero (Linux WebKit rejects it as PKCS#8)', async () => {
    // Expected value from OpenSSL, which imports the key as is.
    const pair = await x25519KeyPairFromPrivateKey(
      fromHex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'),
    );
    expect(hex(pair.publicKey)).toBe(
      '8f40c5adb68f25624ae5b214ea767a6ec94d829d3d7b5e1ad1ba6f3e2138285f',
    );
  });
});

describe('RFC 5869 A.1 (HKDF-SHA-256, test case 1)', () => {
  it('produces the expected OKM', async () => {
    const okm = await hkdfSha256(
      fromHex('0b'.repeat(22)),
      fromHex('000102030405060708090a0b0c'),
      fromHex('f0f1f2f3f4f5f6f7f8f9'),
      42,
    );
    expect(hex(okm)).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });
});

// Patterns the published suites exercise besides KK / XXpsk0. They run through the same
// engine as cross-checks: NN (no statics), IN (a static sent in clear, before any key),
// XX (encrypted statics) and XXpsk3 (psk after the DHs). Noise §7.4, §7.5, §9.4.
const PATTERNS: Readonly<Record<string, HandshakePattern>> = {
  KK,
  XXpsk0: XXPSK0,
  NN: {
    name: 'NN',
    initiatorPreMessage: [],
    responderPreMessage: [],
    messages: [['e'], ['e', 'ee']],
  },
  IN: {
    name: 'IN',
    initiatorPreMessage: [],
    responderPreMessage: [],
    messages: [
      ['e', 's'],
      ['e', 'ee', 'se'],
    ],
  },
  XX: {
    name: 'XX',
    initiatorPreMessage: [],
    responderPreMessage: [],
    messages: [['e'], ['e', 'ee', 's', 'es'], ['s', 'se']],
  },
  XXpsk3: {
    name: 'XXpsk3',
    initiatorPreMessage: [],
    responderPreMessage: [],
    messages: [['e'], ['e', 'ee', 's', 'es'], ['s', 'se', 'psk']],
  },
};

interface Vector {
  readonly source: string;
  readonly protocol_name: string;
  readonly init_prologue: string;
  readonly resp_prologue: string;
  readonly init_psks?: readonly string[];
  readonly resp_psks?: readonly string[];
  readonly init_static?: string;
  readonly resp_static?: string;
  readonly init_ephemeral: string;
  readonly resp_ephemeral: string;
  readonly init_remote_static?: string;
  readonly resp_remote_static?: string;
  readonly handshake_hash?: string;
  readonly messages: readonly { readonly payload: string; readonly ciphertext: string }[];
}

const vectors: readonly Vector[] = fixture.vectors;

/** The `Random` port, answering exactly one 32-byte ephemeral request from the vector. */
function fixedEphemeral(ephemeral: string): { bytes(length: number): Uint8Array } {
  let used = false;
  return {
    bytes(length: number): Uint8Array {
      if (used || length !== 32) throw new Error('unexpected randomness request');
      used = true;
      return fromHex(ephemeral);
    },
  };
}

const keyPair = (secret: string | undefined): Promise<X25519KeyPair> | undefined =>
  secret === undefined ? undefined : x25519KeyPairFromPrivateKey(fromHex(secret));

const psk = (psks: readonly string[] | undefined): Uint8Array | undefined =>
  psks?.[0] === undefined ? undefined : fromHex(psks[0]);

/**
 * Regenerates a vector: replays the handshake and transport messages from the recorded
 * keys, ephemerals, prologues and payloads, both roles at once, and returns what this
 * implementation computes in the fixture's own shape.
 */
async function regenerate(vector: Vector): Promise<
  Pick<Vector, 'messages' | 'handshake_hash'> & {
    derived_remote_statics: readonly [string, string] | undefined;
  }
> {
  const name = /^Noise_(\w+?)_25519_AESGCM_SHA256$/.exec(vector.protocol_name)?.[1];
  const pattern = PATTERNS[name ?? ''];
  if (pattern === undefined) throw new Error(`no pattern for ${vector.protocol_name}`);
  expect(protocolName(pattern)).toBe(vector.protocol_name);
  const initStatic = await keyPair(vector.init_static);
  const respStatic = await keyPair(vector.resp_static);
  const preShared = pattern.responderPreMessage.length > 0;
  const initiator = await HandshakeState.initialize({
    pattern,
    initiator: true,
    prologue: fromHex(vector.init_prologue),
    random: fixedEphemeral(vector.init_ephemeral),
    ...(initStatic && { staticKeyPair: initStatic }),
    ...(preShared && respStatic && { remoteStaticPublicKey: respStatic.publicKey }),
    ...(psk(vector.init_psks) && { psk: psk(vector.init_psks) }),
  });
  const responder = await HandshakeState.initialize({
    pattern,
    initiator: false,
    prologue: fromHex(vector.resp_prologue),
    random: fixedEphemeral(vector.resp_ephemeral),
    ...(respStatic && { staticKeyPair: respStatic }),
    ...(pattern.initiatorPreMessage.length > 0 &&
      initStatic && { remoteStaticPublicKey: initStatic.publicKey }),
    ...(psk(vector.resp_psks) && { psk: psk(vector.resp_psks) }),
  });

  const messages: { payload: string; ciphertext: string }[] = [];
  const handshakeLength = pattern.messages.length;
  // See the fixture's `conventions`: flynn-noise restarts with the initiator after Split.
  const restartAfterSplit = vector.source.startsWith('flynn-noise');
  for (const [index, { payload }] of vector.messages.entries()) {
    const turn = restartAfterSplit && index >= handshakeLength ? index - handshakeLength : index;
    const initiatorSends = turn % 2 === 0;
    let ciphertext: Uint8Array;
    let received: Uint8Array;
    if (index < handshakeLength) {
      const [writer, reader] = initiatorSends ? [initiator, responder] : [responder, initiator];
      ciphertext = await writer.writeMessage(fromHex(payload));
      received = await reader.readMessage(ciphertext);
    } else {
      const [sender, receiver] = initiatorSends
        ? [initiator.result().send, responder.result().receive]
        : [responder.result().send, initiator.result().receive];
      ciphertext = await sender.encryptWithAd(new Uint8Array(0), fromHex(payload));
      received = await receiver.decryptWithAd(new Uint8Array(0), ciphertext);
    }
    expect(hex(received)).toBe(payload);
    messages.push({ payload, ciphertext: hex(ciphertext) });
  }

  const initResult = initiator.result();
  const respResult = responder.result();
  expect(hex(initResult.handshakeHash)).toBe(hex(respResult.handshakeHash));
  // Each side ends up holding the other's static key, whether pre-shared or transmitted.
  const derived =
    initResult.remoteStaticPublicKey && respResult.remoteStaticPublicKey
      ? ([hex(initResult.remoteStaticPublicKey), hex(respResult.remoteStaticPublicKey)] as const)
      : undefined;
  return {
    messages,
    ...(vector.handshake_hash !== undefined && { handshake_hash: hex(initResult.handshakeHash) }),
    derived_remote_statics: derived,
  };
}

describe('Noise vectors (fixtures/noise-vectors.json)', () => {
  it('covers KK and XXpsk0 from more than one independent implementation', () => {
    const sources = (protocol: string): string[] =>
      vectors
        .filter((v) => v.protocol_name === protocol)
        .map((v) => v.source.split(/[#/]/)[0] ?? '');
    expect(new Set(sources('Noise_KK_25519_AESGCM_SHA256'))).toEqual(
      new Set(['cacophony', 'snow', 'flynn-noise']),
    );
    expect(sources('Noise_XXpsk0_25519_AESGCM_SHA256')).toHaveLength(4);
  });

  it.each(vectors.map((vector) => [vector.source, vector.protocol_name, vector] as const))(
    'regenerates %s (%s) byte for byte',
    async (_source, _protocol, vector) => {
      const regenerated = await regenerate(vector);
      expect(regenerated.messages).toEqual(vector.messages);
      expect(regenerated.handshake_hash).toBe(vector.handshake_hash);
      if (vector.init_remote_static !== undefined && vector.resp_remote_static !== undefined) {
        expect(regenerated.derived_remote_statics).toEqual([
          vector.init_remote_static,
          vector.resp_remote_static,
        ]);
      }
    },
  );
});
