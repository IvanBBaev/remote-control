// Shared test fixtures. Lives outside src/, so it is neither shipped nor counted in
// coverage. No `node:*` imports: everything here also runs in a browser.
import type { Random } from '@remote-control/protocol';

import {
  HandshakeState,
  KK,
  sessionPrologue,
  TransportSession,
  x25519KeyPairFromPrivateKey,
  XXPSK0,
  type EnvelopeHeader,
  type HandshakeResult,
  type X25519KeyPair,
} from '../src/index.js';

/** Deterministic `Random` for tests (xorshift32); never use outside tests. */
export function seededRandom(seed: number): Random {
  let state = seed >>> 0 || 1;
  return {
    bytes(length: number): Uint8Array {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        out[i] = state & 0xff;
      }
      return out;
    },
  };
}

export async function staticKey(seed: number): Promise<X25519KeyPair> {
  return x25519KeyPairFromPrivateKey(seededRandom(seed).bytes(32));
}

export const USER = '0190a1b2-0000-7000-8000-000000000001';
export const PHONE = '0190a1b2-0000-7000-8000-0000000000a1';
export const AGENT = '0190a1b2-0000-7000-8000-0000000000b2';
export const OTHER = '0190a1b2-0000-7000-8000-0000000000c3';

export const PROLOGUE = sessionPrologue({
  userId: USER,
  phoneDeviceId: PHONE,
  agentDeviceId: AGENT,
});

/** A data-envelope header from the phone to the agent; override any field. */
export function header(overrides: Partial<EnvelopeHeader> = {}): EnvelopeHeader {
  return {
    v: 1,
    kind: 'data',
    id: '0190a1b2-1111-7000-8000-000000000001',
    from: PHONE,
    to: AGENT,
    session: '0190a1b2-2222-7000-8000-000000000001',
    cls: 'request',
    seq: 0,
    ts: 1_760_000_000_000,
    expiresAt: null,
    ...overrides,
  };
}

export interface KkOptions {
  readonly phoneStatic?: X25519KeyPair;
  readonly agentStatic?: X25519KeyPair;
  /** What the agent believes the phone's static key is (revocation tests). */
  readonly agentExpectsPhone?: Uint8Array;
  readonly phonePrologue?: Uint8Array;
  readonly agentPrologue?: Uint8Array;
  readonly seed?: number;
  readonly messageLimit?: number;
}

/** Runs a full KK handshake (phone = initiator) and returns both results. */
export async function kkHandshake(
  options: KkOptions = {},
): Promise<{ phone: HandshakeResult; agent: HandshakeResult }> {
  const phoneStatic = options.phoneStatic ?? (await staticKey(101));
  const agentStatic = options.agentStatic ?? (await staticKey(202));
  const seed = options.seed ?? 7;
  const limit = options.messageLimit === undefined ? {} : { messageLimit: options.messageLimit };
  const phone = await HandshakeState.initialize({
    pattern: KK,
    initiator: true,
    prologue: options.phonePrologue ?? PROLOGUE,
    random: seededRandom(seed),
    staticKeyPair: phoneStatic,
    remoteStaticPublicKey: agentStatic.publicKey,
    ...limit,
  });
  const agent = await HandshakeState.initialize({
    pattern: KK,
    initiator: false,
    prologue: options.agentPrologue ?? PROLOGUE,
    random: seededRandom(seed + 1),
    staticKeyPair: agentStatic,
    remoteStaticPublicKey: options.agentExpectsPhone ?? phoneStatic.publicKey,
    ...limit,
  });
  await agent.readMessage(await phone.writeMessage());
  await phone.readMessage(await agent.writeMessage());
  return { phone: phone.result(), agent: agent.result() };
}

/** Two transport sessions over a fresh KK handshake. */
export async function kkSessions(
  options: KkOptions = {},
): Promise<{ phone: TransportSession; agent: TransportSession }> {
  const { phone, agent } = await kkHandshake(options);
  return {
    phone: TransportSession.fromHandshake(phone),
    agent: TransportSession.fromHandshake(agent),
  };
}

export interface PairingOptions {
  readonly phonePsk?: Uint8Array;
  readonly agentPsk?: Uint8Array;
  readonly phonePrologue?: Uint8Array;
  readonly agentPrologue?: Uint8Array;
}

/** XXpsk0 pairing (phone = initiator) up to the given number of messages. */
export async function pairingStates(options: PairingOptions = {}): Promise<{
  phone: HandshakeState;
  agent: HandshakeState;
  phoneStatic: X25519KeyPair;
  agentStatic: X25519KeyPair;
}> {
  const psk = new Uint8Array(32).fill(0x42);
  const phoneStatic = await staticKey(303);
  const agentStatic = await staticKey(404);
  const prologue = new Uint8Array([1, 2, 3]);
  const phone = await HandshakeState.initialize({
    pattern: XXPSK0,
    initiator: true,
    prologue: options.phonePrologue ?? prologue,
    random: seededRandom(11),
    staticKeyPair: phoneStatic,
    psk: options.phonePsk ?? psk,
  });
  const agent = await HandshakeState.initialize({
    pattern: XXPSK0,
    initiator: false,
    prologue: options.agentPrologue ?? prologue,
    random: seededRandom(12),
    staticKeyPair: agentStatic,
    psk: options.agentPsk ?? psk,
  });
  return { phone, agent, phoneStatic, agentStatic };
}
