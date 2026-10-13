import {
  generateX25519KeyPair,
  HandshakeState,
  KK,
  pairingPrologue,
  sessionPrologue,
  TransportSession,
  webCryptoRandom,
  XXPSK0,
} from '@remote-control/crypto';
import type { X25519KeyPair } from '@remote-control/crypto';
import { HANDSHAKE_TAG, PhoneMessage, VERSION_TABLE } from '@remote-control/protocol';
import type { AgentMessage, Envelope } from '@remote-control/protocol';

import { fromBase64, header, toBase64, uuidV7 } from './envelope.js';
import type { FakeSocket } from './fake-socket.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface TestAgent {
  readonly deviceId: string;
  readonly keyPair: X25519KeyPair;
  /** Answers the phone's latest KK message on `socket`; the session is then open. */
  acceptKk(socket: FakeSocket): Promise<void>;
  /** Encrypts `message` on the open session and delivers it on `socket`. */
  send(socket: FakeSocket, message: AgentMessage, cls?: Envelope['cls']): Promise<Envelope>;
  /** Decrypts a command envelope the phone sent. */
  read(envelope: Envelope): Promise<PhoneMessage>;
  /** Answers the phone's pairing message with `name`; resolves with the phone's name. */
  acceptPairing(socket: FakeSocket, psk: Uint8Array, name: string): Promise<{ name: string }>;
  /** An agent-originated envelope with a raw payload. */
  envelope(cls: Envelope['cls'], payload: Uint8Array): Envelope;
}

/** The agent's side of KK and XXpsk0 for unit tests: what `apps/agent` does. */
export async function createTestAgent(input: {
  deviceId: string;
  userId: string;
  phoneDeviceId: string;
  phonePublicKey: () => Uint8Array;
  now: () => number;
}): Promise<TestAgent> {
  const keyPair = await generateX25519KeyPair(webCryptoRandom);
  let transport: TransportSession | undefined;
  let seq = 0;

  const envelope = (cls: Envelope['cls'], payload: Uint8Array): Envelope => ({
    v: VERSION_TABLE.v,
    kind: 'data',
    id: uuidV7(input.now(), webCryptoRandom),
    from: input.deviceId,
    to: input.phoneDeviceId,
    session: null,
    cls,
    seq: seq++,
    ts: input.now(),
    expiresAt: null,
    payload: toBase64(payload),
  });

  const control = (tag: number, message: Uint8Array): Envelope => {
    const bytes = new Uint8Array(message.length + 1);
    bytes[0] = tag;
    bytes.set(message, 1);
    return envelope('control', bytes);
  };

  const lastControl = (socket: FakeSocket, tag: number): Uint8Array => {
    const sent = socket
      .of('data')
      .filter((frame) => frame.cls === 'control' && fromBase64(frame.payload)[0] === tag)
      .at(-1);
    if (sent === undefined) throw new Error('test agent: no handshake message from the phone');
    return fromBase64(sent.payload).subarray(1);
  };

  return {
    deviceId: input.deviceId,
    keyPair,
    envelope,
    async acceptKk(socket) {
      const kk = await HandshakeState.initialize({
        pattern: KK,
        initiator: false,
        prologue: sessionPrologue({
          userId: input.userId,
          phoneDeviceId: input.phoneDeviceId,
          agentDeviceId: input.deviceId,
        }),
        random: webCryptoRandom,
        staticKeyPair: keyPair,
        remoteStaticPublicKey: input.phonePublicKey(),
      });
      await kk.readMessage(lastControl(socket, HANDSHAKE_TAG.kk));
      const msg2 = await kk.writeMessage();
      transport = TransportSession.fromHandshake(kk.result());
      socket.receive(control(HANDSHAKE_TAG.kk, msg2));
    },
    async send(socket, message, cls = 'event') {
      if (transport === undefined) throw new Error('test agent: no session');
      const head = envelope(cls, new Uint8Array(0));
      const ciphertext = await transport.encrypt(
        header(head),
        encoder.encode(JSON.stringify(message)),
      );
      const sent = { ...head, payload: toBase64(ciphertext) };
      socket.receive(sent);
      return sent;
    },
    async read(sent) {
      if (transport === undefined) throw new Error('test agent: no session');
      const plaintext = await transport.decrypt(header(sent), fromBase64(sent.payload));
      return PhoneMessage.parse(JSON.parse(decoder.decode(plaintext)));
    },
    async acceptPairing(socket, psk, name) {
      const state = await HandshakeState.initialize({
        pattern: XXPSK0,
        initiator: false,
        prologue: pairingPrologue({ userId: input.userId, agentDeviceId: input.deviceId }),
        random: webCryptoRandom,
        staticKeyPair: keyPair,
        psk,
      });
      const before = socket.of('data').length;
      await state.readMessage(lastControl(socket, HANDSHAKE_TAG.pairing));
      socket.receive(
        control(
          HANDSHAKE_TAG.pairing,
          await state.writeMessage(encoder.encode(JSON.stringify({ name }))),
        ),
      );
      for (let i = 0; i < 100 && socket.of('data').length === before; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const msg3 = await state.readMessage(lastControl(socket, HANDSHAKE_TAG.pairing));
      return JSON.parse(decoder.decode(msg3)) as { name: string };
    },
  };
}
