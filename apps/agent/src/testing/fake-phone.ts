import {
  generateX25519KeyPair,
  HandshakeState,
  KK,
  pairingPrologue,
  sessionPrologue,
  TransportSession,
  XXPSK0,
  type X25519KeyPair,
} from '@remote-control/crypto';
import {
  AgentMessage,
  DECISION_TTL_SECONDS,
  decisionHash,
  encodeFrame,
  HANDSHAKE_TAG,
  PairingHello,
  parseFrame,
  requestHash,
  requiresAssertion,
  toBase64Url,
  VERSION_TABLE,
  type ApprovalRequest,
  type CanonicalDecision,
  type DecisionAssertion,
  type DecisionKind,
  type Envelope,
  type Frame,
  type StartSession,
} from '@remote-control/protocol';

import { normalizePairingCode, pairingPsk, slotCodeHash } from '../core/pairing-code.js';
import { uuidV7 } from '../core/uuid.js';
import type { Clock } from '../ports/clock.js';
import type { Peer } from '../ports/key-store.js';
import type { Random } from '../ports/random.js';
import type { WebSocketConnection } from '../ports/web-socket.js';
import { FAKE_RELAY_ORIGIN, type FakeDevice, type FakeRelay } from './fake-relay.js';
import { waitFor } from './manual-time.js';
import type { TestDeviceKey } from './test-device-key.js';
import type { AssertionOverrides, TestPasskey } from './test-passkey.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface DecideOverrides {
  readonly decision?: Partial<CanonicalDecision>;
  /** The envelope's `decisionHash`; default: the true hash for kinds that need one. */
  readonly envelopeHash?: string;
  /** Deviations in the passkey assertion (phones with a passkey only). */
  readonly assertion?: AssertionOverrides;
  /** Rewrites the signed assertion before it is sealed; `undefined` drops it. */
  readonly tamper?: (assertion: DecisionAssertion) => DecisionAssertion | undefined;
  /** Phones with a device key: signs with this key instead (`null`: sends no signature). */
  readonly signer?: TestDeviceKey | null;
  /** Phones with a device key: signs this decision instead of the one sent. */
  readonly signed?: Partial<CanonicalDecision>;
}

export interface Received {
  readonly envelope: Envelope;
  readonly message: AgentMessage;
}

export interface FakePhone {
  readonly device: FakeDevice;
  readonly keyPair: X25519KeyPair;
  /** Decrypted agent messages, in arrival order. */
  readonly messages: Received[];
  /** Empty `cls: request` envelopes (push doorbells). */
  readonly doorbells: Envelope[];
  connect(): Promise<void>;
  disconnect(): void;
  /**
   * Runs the KK initiator against the agent (D3) and waits for the snapshot. A test that
   * expects a refusal passes `slowRounds: 0`, so the wait gives up after the fast turns.
   */
  handshake(agentDeviceId: string, agentPublicKey: Uint8Array, slowRounds?: number): Promise<void>;
  /** Sends a decision on the open session; returns the command envelope id. */
  decide(
    kind: DecisionKind,
    request: Pick<ApprovalRequest, 'id' | 'requestHash'>,
    overrides?: DecideOverrides,
  ): Promise<string>;
  /**
   * Sends a `start` (M1-04) for `repositoryId` on `machineId`; `path` is the repository's
   * configured root the request hash covers. Returns the command envelope id.
   */
  start(start: StartSession, path: string, overrides?: DecideOverrides): Promise<string>;
  /** Sends an `instruct` (M1-04) to `sessionId`; returns the command envelope id. */
  instruct(sessionId: string, text: string, overrides?: DecideOverrides): Promise<string>;
  /** Asks for a changed file's diff (M2-02); returns the command envelope id. */
  requestDiff(sessionId: string, file: string): Promise<string>;
  /** Joins a pairing slot with the code and runs the XXpsk0 initiator (D6). */
  pair(code: string): Promise<{ agentDeviceId: string; agentPublicKey: Uint8Array; name: string }>;
  /** The phone as the agent's `peers.json` should list it. */
  peer(pairedAt: number): Peer;
  /** Messages of type `t`. */
  of<T extends AgentMessage['t']>(t: T): Extract<AgentMessage, { t: T }>[];
}

function header(envelope: Envelope): Omit<Envelope, 'payload'> {
  return Object.fromEntries(Object.entries(envelope).filter(([key]) => key !== 'payload')) as Omit<
    Envelope,
    'payload'
  >;
}

/** A phone built from `packages/crypto`, talking to the agent through the fake relay. */
export async function createFakePhone(
  relay: FakeRelay,
  name: string,
  clock: Clock,
  random: Random,
  /**
   * The phone's passkey (M2-03): handed to the agent at pairing, and every decision that
   * needs one carries its assertion. Without it the phone is one paired before M2-03.
   * A device key (M4-04) makes it the native app: decisions carry a device signature and
   * no envelope `decisionHash`, as the relay never sees that proof.
   */
  key?: TestPasskey | TestDeviceKey,
): Promise<FakePhone> {
  const passkey = key && 'assert' in key ? key : undefined;
  const deviceKey = key && 'sign' in key ? key : undefined;
  const device = relay.addPhone(name);
  const keyPair = await generateX25519KeyPair(random);
  let socket: WebSocketConnection | undefined;
  let ready = false;
  let seq = 0;
  let transport: TransportSession | undefined;
  let kk: HandshakeState | undefined;
  let pairing:
    { state: HandshakeState; done?: { name: string; agentPublicKey: Uint8Array } } | undefined;
  let chain: Promise<void> = Promise.resolve();
  let agentId = '';
  const messages: Received[] = [];
  const doorbells: Envelope[] = [];

  function send(frame: Frame): void {
    socket?.send(encodeFrame(frame));
  }

  function envelope(to: string, cls: Envelope['cls'], payload: Uint8Array): Envelope {
    return {
      v: VERSION_TABLE.v,
      kind: 'data',
      id: uuidV7(clock, random),
      from: device.id,
      to,
      session: null,
      cls,
      seq: seq++,
      ts: clock.now(),
      expiresAt: null,
      payload: Buffer.from(payload).toString('base64'),
    };
  }

  function control(to: string, tag: number, message: Uint8Array): void {
    const bytes = new Uint8Array(message.length + 1);
    bytes[0] = tag;
    bytes.set(message, 1);
    send(envelope(to, 'control', bytes));
  }

  async function onEnvelope(received: Envelope): Promise<void> {
    const bytes = new Uint8Array(Buffer.from(received.payload, 'base64'));
    if (received.cls === 'control') {
      if (bytes[0] === HANDSHAKE_TAG.kk && kk !== undefined) {
        await kk.readMessage(bytes.subarray(1));
        transport = TransportSession.fromHandshake(kk.result());
        kk = undefined;
      } else if (bytes[0] === HANDSHAKE_TAG.pairing && pairing !== undefined) {
        const { state } = pairing;
        const hello = PairingHello.parse(
          JSON.parse(decoder.decode(await state.readMessage(bytes.subarray(1)))),
        );
        const msg3 = await state.writeMessage(
          encoder.encode(
            JSON.stringify({
              name,
              ...(passkey && { passkeys: [passkey.paired] }),
              ...(deviceKey && { deviceKey: deviceKey.paired }),
            }),
          ),
        );
        control(received.from, HANDSHAKE_TAG.pairing, msg3);
        pairing.done = { name: hello.name, agentPublicKey: state.remoteStaticPublicKey! };
      }
      return;
    }
    if (bytes.length === 0) {
      doorbells.push(received);
      return;
    }
    if (transport === undefined) return;
    const plaintext = await transport.decrypt(header(received), bytes);
    messages.push({
      envelope: received,
      message: AgentMessage.parse(JSON.parse(decoder.decode(plaintext))),
    });
  }

  /** Sends a D7 decision inside `body` (or a plain `decision` message). */
  async function command(
    kind: DecisionKind,
    requestId: string,
    hashOfRequest: string,
    payload: string | null,
    body: Readonly<Record<string, unknown>>,
    overrides: DecideOverrides,
  ): Promise<string> {
    const issuedAt = Math.floor(clock.now() / 1000);
    const decision: CanonicalDecision = {
      v: VERSION_TABLE.v,
      kind,
      request_id: requestId,
      request_hash: hashOfRequest,
      payload,
      issued_at: issuedAt,
      expires_at: issuedAt + DECISION_TTL_SECONDS,
      phone_device_id: device.id,
      agent_device_id: agentId,
      ...overrides.decision,
    };
    const hash = await decisionHash(decision);
    if (requiresAssertion(kind)) relay.verified.add(hash);
    const envelopeHash =
      overrides.envelopeHash ?? (requiresAssertion(kind) && !deviceKey ? hash : undefined);
    const head = {
      ...envelope(agentId, 'command', new Uint8Array(0)),
      ...(envelopeHash === undefined ? {} : { decisionHash: envelopeHash }),
    };
    let assertion =
      passkey && requiresAssertion(kind)
        ? await passkey.assert(decision, overrides.assertion)
        : undefined;
    if (assertion !== undefined && overrides.tamper) assertion = overrides.tamper(assertion);
    const signer = overrides.signer === undefined ? deviceKey : overrides.signer;
    const deviceSignature =
      deviceKey && signer && requiresAssertion(kind)
        ? await signer.sign({ ...decision, ...overrides.signed })
        : undefined;
    const plaintext = encoder.encode(
      JSON.stringify({
        t: 'decision',
        ...body,
        decision,
        ...(assertion && { assertion }),
        ...(deviceSignature && { deviceSignature }),
      }),
    );
    const ciphertext = await transport!.encrypt(header(head), plaintext);
    send({ ...head, payload: Buffer.from(ciphertext).toString('base64') });
    return head.id;
  }

  const phone: FakePhone = {
    device,
    keyPair,
    messages,
    doorbells,
    async connect() {
      ready = false;
      socket = relay.webSocket(
        `${FAKE_RELAY_ORIGIN}/ws`,
        { authorization: `Bearer ${device.token}` },
        {
          onOpen: () =>
            send({
              v: VERSION_TABLE.v,
              kind: 'hello',
              protocol: { min: 1, max: 1 },
              client: { kind: 'phone', version: 'test' },
            }),
          onMessage(text) {
            const parsed = parseFrame(text);
            if (!parsed.ok) return;
            if (parsed.frame.kind === 'hello_ok') ready = true;
            if (parsed.frame.kind !== 'data') return;
            const frame = parsed.frame;
            chain = chain.then(() => onEnvelope(frame));
          },
          onClose() {
            ready = false;
            transport = undefined;
          },
        },
      );
      await waitFor(() => ready);
    },
    disconnect() {
      socket?.close(1000, 'bye');
      socket = undefined;
      transport = undefined;
    },
    async handshake(agentDeviceId, agentPublicKey, slowRounds) {
      agentId = agentDeviceId;
      transport = undefined;
      const before = messages.length;
      kk = await HandshakeState.initialize({
        pattern: KK,
        initiator: true,
        prologue: sessionPrologue({
          userId: relay.userId,
          phoneDeviceId: device.id,
          agentDeviceId,
        }),
        random,
        staticKeyPair: keyPair,
        remoteStaticPublicKey: agentPublicKey,
      });
      control(agentDeviceId, HANDSHAKE_TAG.kk, await kk.writeMessage());
      await waitFor(
        () => messages.slice(before).some((r) => r.message.t === 'snapshot'),
        undefined,
        slowRounds,
      );
    },
    decide(kind, request, overrides = {}) {
      return command(kind, request.id, request.requestHash, null, {}, overrides);
    },
    async start(start, path, overrides = {}) {
      const hash = await requestHash({
        prompt: start.prompt,
        cwd: path,
        permissionMode: start.permissionMode,
      });
      return command(
        'start',
        uuidV7(clock, random),
        hash,
        start.repositoryId,
        { t: 'start', start },
        overrides,
      );
    },
    async instruct(sessionId, text, overrides = {}) {
      const hash = await requestHash({ prompt: text, sessionId });
      const body = { t: 'instruct', instruction: { sessionId, text } };
      return command('instruct', uuidV7(clock, random), hash, text, body, overrides);
    },
    async requestDiff(sessionId, file) {
      const head = envelope(agentId, 'command', new Uint8Array(0));
      const body = { t: 'diff_request', requestId: uuidV7(clock, random), sessionId, file };
      const plaintext = encoder.encode(JSON.stringify(body));
      const ciphertext = await transport!.encrypt(header(head), plaintext);
      send({ ...head, payload: Buffer.from(ciphertext).toString('base64') });
      return head.id;
    },
    async pair(code) {
      const psk = await pairingPsk(normalizePairingCode(code)!);
      const response = await relay.fetch(`${FAKE_RELAY_ORIGIN}/api/pairings/join`, {
        method: 'POST',
        headers: { authorization: `Bearer ${device.token}` },
        body: JSON.stringify({ codeHash: await slotCodeHash(psk) }),
      });
      const joined = (await response.json()) as { agentDeviceId: string };
      const state = await HandshakeState.initialize({
        pattern: XXPSK0,
        initiator: true,
        prologue: pairingPrologue({ userId: relay.userId, agentDeviceId: joined.agentDeviceId }),
        random,
        staticKeyPair: keyPair,
        psk,
      });
      const current = { state } as NonNullable<typeof pairing>;
      pairing = current;
      control(joined.agentDeviceId, HANDSHAKE_TAG.pairing, await state.writeMessage());
      await waitFor(() => current.done !== undefined);
      pairing = undefined;
      return { agentDeviceId: joined.agentDeviceId, ...current.done! };
    },
    peer: (pairedAt) => ({
      deviceId: device.id,
      name,
      publicKey: toBase64Url(keyPair.publicKey),
      pairedAt,
      ...(passkey && { passkeys: [{ ...passkey.paired, counter: 0 }] }),
      ...(deviceKey && { deviceKey: deviceKey.paired }),
    }),
    of: <T extends AgentMessage['t']>(t: T) =>
      messages
        .map((received) => received.message)
        .filter((message): message is Extract<AgentMessage, { t: T }> => message.t === t),
  };
  return phone;
}
