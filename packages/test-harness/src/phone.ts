import {
  generateX25519KeyPair,
  hkdfSha256,
  HandshakeState,
  KK,
  pairingPrologue,
  PSK_LENGTH,
  sessionPrologue,
  TransportSession,
  utf8,
  webCryptoRandom,
  XXPSK0,
  type X25519KeyPair,
} from '@remote-control/crypto';
import {
  accountDeletionHash,
  AgentMessage,
  DECISION_TTL_SECONDS,
  decisionChallenge,
  decisionHash,
  encodeFrame,
  HANDSHAKE_TAG,
  PairingHello,
  parseFrame,
  requestHash,
  requiresAssertion,
  toBase64Url,
  toHex,
  VERSION_TABLE,
  type ApprovalRequest,
  type CanonicalDecision,
  type DecisionAssertion,
  type DecisionKind,
  type Envelope,
  type Frame,
  type PairedPasskey,
  type StartSession,
} from '@remote-control/protocol';
import { SoftwareAuthenticator } from '@remote-control/relay/testing';
import WebSocket from 'ws';

import { eventually } from './eventually.js';
import type { HarnessClock } from './fake-clock.js';
import type { HarnessRelay } from './relay.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const EMPTY = new Uint8Array(0);
const SESSION_COOKIE = /^__Host-rc_session=([^;]+);/;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

type CreationOptions = Parameters<SoftwareAuthenticator['create']>[0];
type RequestOptions = Parameters<SoftwareAuthenticator['get']>[0];

export interface Received {
  readonly envelope: Envelope;
  readonly message: AgentMessage;
}

export interface Paired {
  readonly agentDeviceId: string;
  readonly agentPublicKey: Uint8Array;
  /** The name the agent told the phone inside the handshake. */
  readonly name: string;
}

export interface CreatePhoneOptions {
  readonly relay: HarnessRelay;
  readonly clock: HarnessClock;
  /** The device name the agent sees. */
  readonly name: string;
  /**
   * Run the relay's passkey check (D7 phase 1) before each decision that needs one and
   * name the decision hash in the envelope (default: yes). `false` leaves the agent's own
   * check (phase 2, M2-03) as the only one: the relay forwards with no `verified` flag.
   */
  readonly relayCheck?: boolean;
  /**
   * More relays on the same database: HTTP calls rotate across `relay` and these, as
   * Railway's load balancer spreads requests over replicas (ADR 0016). The socket stays
   * on `relay`.
   */
  readonly replicas?: readonly HarnessRelay[];
}

export interface DecideOptions {
  /** Alters the assertion after the ceremony, before it is sealed (tamper tests, W15). */
  readonly tamper?: (assertion: DecisionAssertion) => DecisionAssertion;
}

export interface HeadlessPhone {
  readonly keyPair: X25519KeyPair;
  readonly authenticator: SoftwareAuthenticator;
  /** Set by `register`. */
  readonly userId: string;
  /** The passkey public keys `register` kept, handed to the agent at pairing (M2-03). */
  readonly passkeys: readonly PairedPasskey[];
  /** Set by `bind`. */
  readonly deviceId: string;
  /** The `__Host-rc_session` value `register` got, for a browser to sign in with (M1-12). */
  readonly sessionCookie: string;
  /** How the relay closed the last socket (`4002 revoked`, M1-10); null while open. */
  readonly closed: { readonly code: number; readonly reason: string } | null;
  /** Decrypted agent messages, in arrival order. */
  readonly messages: Received[];
  /** Empty `cls: request` envelopes (doorbells). */
  readonly doorbells: Envelope[];
  /** Redeems an invite with a software passkey; keeps the session cookie. */
  register(inviteCode: string): Promise<void>;
  /** `POST /api/devices/phone`. */
  bind(): Promise<void>;
  /** `POST /api/agents`: the enrolment token `remotectl login` takes. */
  enrollAgent(name: string): Promise<{ deviceId: string; enrollToken: string }>;
  /** Subscribes at the relay's fake push service. */
  subscribePush(): Promise<void>;
  /** Opens `/ws` with the session cookie and waits for `hello_ok`. */
  connect(): Promise<void>;
  disconnect(): void;
  /** Joins the agent's pairing slot with the code and runs the XXpsk0 initiator (D6). */
  pair(code: string): Promise<Paired>;
  /** Runs the KK initiator (D3) and waits for the agent's snapshot. */
  handshake(agentDeviceId: string, agentPublicKey: Uint8Array): Promise<void>;
  /**
   * Sends a decision on the open session, with the passkey ceremony (at the relay unless
   * `relayCheck` is off) for the kinds that need one and the assertion sealed in for the
   * agent (D7); returns the command envelope id. `payload` is the decision's signed
   * payload (an encoded `AnswerPayload` for `answer`, M1-01).
   */
  decide(
    kind: DecisionKind,
    request: Pick<ApprovalRequest, 'id' | 'requestHash'>,
    payload?: string | null,
    options?: DecideOptions,
  ): Promise<string>;
  /**
   * Asks the agent to start a session (M1-04): a `start` decision over the repository id,
   * its `request_hash` over the prompt, the repository's `path` as the snapshot showed it
   * and the picked permission mode (M2-09), with a fresh request id. Returns the request
   * id the `decision_result` names.
   */
  start(start: StartSession, path: string): Promise<string>;
  /**
   * Sends a follow-up to a background session (M1-04): an `instruct` decision. Returns the
   * request id.
   */
  instruct(sessionId: string, text: string): Promise<string>;
  /** `DELETE /api/devices/:deviceId` (M1-10): revokes a phone or agent of the account. */
  revokeDevice(deviceId: string): Promise<void>;
  /**
   * Deletes the account (M1-10): a user-verifying assertion over
   * `accountDeletionHash(userId)` through `/api/decisions/*`, then `DELETE /api/account`.
   */
  deleteAccount(): Promise<void>;
  /** Messages of type `t`. */
  of<T extends AgentMessage['t']>(t: T): Extract<AgentMessage, { t: T }>[];
}

function header(envelope: Envelope): Omit<Envelope, 'payload'> {
  return Object.fromEntries(Object.entries(envelope).filter(([key]) => key !== 'payload')) as Omit<
    Envelope,
    'payload'
  >;
}

/** The PWA's own derivations (D6), kept apart from the agent's on purpose. */
async function pairingSecrets(code: string): Promise<{ psk: Uint8Array; codeHash: string }> {
  const normalized = code
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (normalized.length !== 12 || [...normalized].some((char) => !CROCKFORD.includes(char))) {
    throw new Error(`phone: not a pairing code: ${code}`);
  }
  const psk = await hkdfSha256(utf8(normalized), EMPTY, utf8('rc/v1/pair-psk'), PSK_LENGTH);
  const codeHash = toBase64Url(await hkdfSha256(psk, EMPTY, utf8('rc/v1/pair-slot'), 32));
  return { psk, codeHash };
}

function uuidV7(clock: HarnessClock): string {
  const bytes = webCryptoRandom.bytes(16);
  let ms = clock.now();
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The phone headless (07 §5.6): what the PWA does, over real HTTP and a real WebSocket
 * with the `__Host-rc_session` cookie, a software passkey, and `packages/crypto`.
 */
export async function createPhone(options: CreatePhoneOptions): Promise<HeadlessPhone> {
  const { relay, clock, name } = options;
  const relayCheck = options.relayCheck ?? true;
  const passkeys: PairedPasskey[] = [];
  const random = webCryptoRandom;
  const keyPair = await generateX25519KeyPair(random);
  const authenticator = new SoftwareAuthenticator(relay.rpId, relay.origin);
  let cookie = '';
  let userId = '';
  let deviceId = '';
  let socket: WebSocket | undefined;
  let closed: { code: number; reason: string } | null = null;
  let ready = false;
  let seq = 0;
  let agentId = '';
  let transport: TransportSession | undefined;
  let kk: HandshakeState | undefined;
  let pairing:
    { state: HandshakeState; done?: { name: string; agentPublicKey: Uint8Array } } | undefined;
  let chain: Promise<void> = Promise.resolve();
  let failure: unknown;
  const messages: Received[] = [];
  const doorbells: Envelope[] = [];

  const httpRelays = [relay, ...(options.replicas ?? [])];
  let calls = 0;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const target = httpRelays[calls++ % httpRelays.length]!;
    const response = await fetch(`${target.url}${path}`, {
      method,
      headers: {
        origin: relay.origin,
        'sec-fetch-site': 'same-origin',
        'x-rc-client': 'pwa',
        ...(cookie === '' ? {} : { cookie: `__Host-rc_session=${cookie}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookie = SESSION_COOKIE.exec(response.headers.get('set-cookie') ?? '');
    if (setCookie !== null) cookie = setCookie[1]!;
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`phone: ${method} ${path} → ${String(response.status)} ${text}`);
    }
    return (text === '' ? undefined : JSON.parse(text)) as T;
  }

  function send(frame: Frame): void {
    socket?.send(encodeFrame(frame));
  }

  function envelope(to: string, cls: Envelope['cls'], payload: Uint8Array): Envelope {
    return {
      v: VERSION_TABLE.v,
      kind: 'data',
      id: uuidV7(clock),
      from: deviceId,
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
          encoder.encode(JSON.stringify({ name, ...(passkeys.length > 0 && { passkeys }) })),
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

  /** Waits for `predicate`, surfacing a failure inside the frame handler instead. */
  async function until(predicate: () => boolean, message: string): Promise<void> {
    await eventually(() => failure !== undefined || predicate(), message);
    if (failure !== undefined) {
      throw failure instanceof Error
        ? failure
        : new Error('phone: frame handler failed', { cause: failure });
    }
  }

  /**
   * The passkey ceremony over `decision` (D7): at the relay, which then vouches for the
   * hash, or (`relayCheck` off) straight on the authenticator, as only the agent checks it.
   */
  async function assert(decision: CanonicalDecision, hash: string): Promise<DecisionAssertion> {
    let options: RequestOptions;
    if (relayCheck) {
      options = await call<RequestOptions>('POST', '/api/decisions/challenge', {
        decisionHash: hash,
      });
    } else {
      options = {
        challenge: await decisionChallenge(decision),
        rpId: relay.rpId,
        userVerification: 'required',
      };
    }
    const response = await authenticator.get(options);
    if (relayCheck) await call('POST', '/api/decisions/verify', { response });
    return {
      credentialId: response.id,
      authenticatorData: response.response.authenticatorData,
      clientDataJSON: response.response.clientDataJSON,
      signature: response.response.signature,
    };
  }

  /**
   * Signs a decision, runs the passkey ceremony for the kinds that need one (D7) and sends
   * it on the open session with the assertion sealed in; `body` replaces the plain
   * `decision` message (`start`, `instruct`). Returns the command envelope id.
   */
  async function command(
    kind: DecisionKind,
    requestId: string,
    hashOfRequest: string,
    payload: string | null,
    body: Readonly<Record<string, unknown>>,
    decideOptions: DecideOptions = {},
  ): Promise<string> {
    if (transport === undefined) throw new Error('phone: no session');
    const issuedAt = Math.floor(clock.now() / 1000);
    const decision: CanonicalDecision = {
      v: VERSION_TABLE.v,
      kind,
      request_id: requestId,
      request_hash: hashOfRequest,
      payload,
      issued_at: issuedAt,
      expires_at: issuedAt + DECISION_TTL_SECONDS,
      phone_device_id: deviceId,
      agent_device_id: agentId,
    };
    const hash = await decisionHash(decision);
    const signed = requiresAssertion(kind);
    let assertion = signed ? await assert(decision, hash) : undefined;
    if (assertion !== undefined && decideOptions.tamper) {
      assertion = decideOptions.tamper(assertion);
    }
    const head = {
      ...envelope(agentId, 'command', EMPTY),
      ...(signed && relayCheck ? { decisionHash: hash } : {}),
    };
    const plaintext = encoder.encode(
      JSON.stringify({ t: 'decision', ...body, decision, ...(assertion && { assertion }) }),
    );
    const ciphertext = await transport.encrypt(header(head), plaintext);
    send({ ...head, payload: Buffer.from(ciphertext).toString('base64') });
    return head.id;
  }

  const phone: HeadlessPhone = {
    keyPair,
    authenticator,
    get sessionCookie() {
      return cookie;
    },
    get userId() {
      return userId;
    },
    passkeys,
    get deviceId() {
      return deviceId;
    },
    get closed() {
      return closed;
    },
    messages,
    doorbells,
    async register(inviteCode) {
      const creation = await call<CreationOptions>('POST', '/api/auth/register/options', {
        inviteCode,
      });
      const response = await authenticator.create(creation);
      const registered = await call<{ userId: string }>(
        'POST',
        '/api/auth/register/verify',
        response,
      );
      userId = registered.userId;
      // What the PWA keeps from `getPublicKey()` for pairing (M2-03).
      if (response.response.publicKey !== undefined && creation.rp.id !== undefined) {
        passkeys.push({
          id: response.id,
          publicKey: response.response.publicKey,
          rpId: creation.rp.id,
        });
      }
    },
    async bind() {
      deviceId = (await call<{ deviceId: string }>('POST', '/api/devices/phone', { name }))
        .deviceId;
    },
    enrollAgent: (agentName) => call('POST', '/api/agents', { name: agentName }),
    async subscribePush() {
      const subscription = await relay.push.subscribe();
      await call('PUT', '/api/push/subscription', {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      });
    },
    async connect() {
      ready = false;
      closed = null;
      const current = new WebSocket(`${relay.wsOrigin}/ws`, {
        headers: { origin: relay.origin, cookie: `__Host-rc_session=${cookie}` },
      });
      socket = current;
      current.on('open', () =>
        send({
          v: VERSION_TABLE.v,
          kind: 'hello',
          protocol: { min: 1, max: 1 },
          client: { kind: 'phone', version: 'harness' },
        }),
      );
      current.on('message', (data: Buffer) => {
        const parsed = parseFrame(data.toString('utf8'));
        if (!parsed.ok) return;
        if (parsed.frame.kind === 'hello_ok') ready = true;
        if (parsed.frame.kind !== 'data') return;
        const frame = parsed.frame;
        chain = chain
          .then(() => onEnvelope(frame))
          .catch((error: unknown) => {
            failure ??= error;
          });
      });
      current.on('error', (error) => {
        failure ??= error;
      });
      current.on('close', (code: number, reason: Buffer) => {
        if (socket === current) {
          closed = { code, reason: reason.toString('utf8') };
          ready = false;
          transport = undefined;
        }
      });
      await until(() => ready, 'phone: no hello_ok');
    },
    disconnect() {
      socket?.close(1000, 'bye');
      socket = undefined;
      transport = undefined;
    },
    async pair(code) {
      const { psk, codeHash } = await pairingSecrets(code);
      const joined = await call<{ agentDeviceId: string }>('POST', '/api/pairings/join', {
        codeHash,
      });
      const state = await HandshakeState.initialize({
        pattern: XXPSK0,
        initiator: true,
        prologue: pairingPrologue({ userId, agentDeviceId: joined.agentDeviceId }),
        random,
        staticKeyPair: keyPair,
        psk,
      });
      const current = { state } as NonNullable<typeof pairing>;
      pairing = current;
      control(joined.agentDeviceId, HANDSHAKE_TAG.pairing, await state.writeMessage());
      await until(() => current.done !== undefined, 'phone: pairing did not finish');
      pairing = undefined;
      return { agentDeviceId: joined.agentDeviceId, ...current.done! };
    },
    async handshake(agentDeviceId, agentPublicKey) {
      agentId = agentDeviceId;
      transport = undefined;
      const before = messages.length;
      kk = await HandshakeState.initialize({
        pattern: KK,
        initiator: true,
        prologue: sessionPrologue({ userId, phoneDeviceId: deviceId, agentDeviceId }),
        random,
        staticKeyPair: keyPair,
        remoteStaticPublicKey: agentPublicKey,
      });
      control(agentDeviceId, HANDSHAKE_TAG.kk, await kk.writeMessage());
      await until(
        () => messages.slice(before).some((received) => received.message.t === 'snapshot'),
        'phone: no snapshot after the handshake',
      );
    },
    async decide(kind, request, payload = null, decideOptions = {}) {
      return command(kind, request.id, request.requestHash, payload, {}, decideOptions);
    },
    async start(start, path) {
      const requestId = uuidV7(clock);
      const hash = await requestHash({
        prompt: start.prompt,
        cwd: path,
        permissionMode: start.permissionMode,
      });
      await command('start', requestId, hash, start.repositoryId, { t: 'start', start });
      return requestId;
    },
    async instruct(sessionId, text) {
      const requestId = uuidV7(clock);
      const hash = await requestHash({ prompt: text, sessionId });
      await command('instruct', requestId, hash, text, {
        t: 'instruct',
        instruction: { sessionId, text },
      });
      return requestId;
    },
    async revokeDevice(id) {
      await call('DELETE', `/api/devices/${id}`);
    },
    async deleteAccount() {
      const challenge = await call<RequestOptions>('POST', '/api/decisions/challenge', {
        decisionHash: await accountDeletionHash(userId),
      });
      await call('POST', '/api/decisions/verify', {
        response: await authenticator.get(challenge),
      });
      await call('DELETE', '/api/account');
    },
    of: <T extends AgentMessage['t']>(t: T) =>
      messages
        .map((received) => received.message)
        .filter((message): message is Extract<AgentMessage, { t: T }> => message.t === t),
  };
  return phone;
}
