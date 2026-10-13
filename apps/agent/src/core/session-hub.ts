import {
  HandshakeState,
  KK,
  sessionPrologue,
  TransportSession,
  type EnvelopeHeader,
  type X25519KeyPair,
} from '@remote-control/crypto';
import {
  decisionHash,
  HANDSHAKE_TAG,
  PhoneMessage,
  VERSION_TABLE,
  type AgentMessage,
  type Capabilities,
  type Envelope,
  type Machine,
  type PresenceEntry,
  type Presence,
  type Session,
} from '@remote-control/protocol';

import type { AdapterDecision } from '../ports/agent-adapter.js';
import type { Clock } from '../ports/clock.js';
import type { Peer } from '../ports/key-store.js';
import type { Random } from '../ports/random.js';
import { approvalView, pendingRequestHash } from './approval-view.js';
import { checkDecision, M0_DECISION_KINDS } from './decision-check.js';
import { fromBase64Url } from './from-base64url.js';
import type { PendingEvent, PendingRequest, PendingStore } from './pending-store.js';
import { uuidV7 } from './uuid.js';

/** What the hub logs: event names and ids only, never a payload or a key (I3). */
export type HubLog = (event: string, fields: Readonly<Record<string, unknown>>) => void;

export interface SessionHubOptions {
  readonly clock: Clock;
  readonly random: Random;
  /** The account's user id (bound into the KK prologue, D3). */
  readonly userId: string;
  /** The agent's static key (Noise `s`). */
  readonly deviceKey: X25519KeyPair;
  readonly store: PendingStore;
  /** The paired phones (`peers.json`); re-read at every relay connect and handshake. */
  readonly listPeers: () => Promise<readonly Peer[]>;
  /** Sends one envelope on the relay link; `false` when the link is down. */
  readonly send: (envelope: Envelope) => boolean;
  /** The adapter's hook output for a phone decision (`claudeCodeAdapter.decide`). */
  readonly decide: (
    request: PendingRequest,
    decision: AdapterDecision,
  ) => Readonly<Record<string, unknown>>;
  /** The machine as the snapshot shows it; `id` comes from the relay's `hello_ok`. */
  readonly machine: Omit<Machine, 'id' | 'agents'>;
  readonly capabilities: readonly Capabilities[];
  readonly log?: HubLog;
}

/** The end-to-end side of the relay link: KK sessions per phone and decision intake. */
export interface SessionHub {
  /** The relay accepted the agent: its device id and who is online. */
  relayReady(agentDeviceId: string, presence: readonly PresenceEntry[]): void;
  /** The relay link is gone: every session ends (a session never outlives its link, D3). */
  relayDown(): void;
  presence(presence: Presence): void;
  /** A data envelope from the relay. */
  envelope(envelope: Envelope): void;
  /** Feed of the pending store (`onEvent`). */
  pendingEvent(event: PendingEvent): void;
  /** Resolves when all queued work (handshakes, decisions, sends) has run. */
  idle(): Promise<void>;
  /** Phones with an established session (tests, status). */
  sessions(): readonly string[];
}

interface PhoneSession {
  readonly phoneId: string;
  readonly transport: TransportSession;
}

/** Why a request left the phones' view, by the decision that ended it. */
type Winner = { readonly phoneId: string; readonly outcome: 'allow' | 'deny' | 'terminal' };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64'));
}

function header(envelope: Envelope): EnvelopeHeader {
  return Object.fromEntries(
    Object.entries(envelope).filter(([key]) => key !== 'payload'),
  ) as EnvelopeHeader;
}

/**
 * The agent's end of every phone session (D3, D4, D7, D25):
 *
 * - KK responder per paired phone, prologue `rc/v1 || user || phone || agent`; a new
 *   handshake from the same phone replaces its session. After each handshake the phone
 *   gets every pending request (with the time left) and a snapshot.
 * - New permission requests go to every phone with a session; a paired phone without one
 *   gets an empty `cls: request` doorbell, which the relay turns into a Web Push when
 *   the phone is offline. The doorbell carries no plaintext (I3).
 * - Decisions pass the D7 checks in order and apply exactly once (decide-once): the
 *   store refuses a second decision, and the other phones learn the outcome (`resolved`).
 *
 * Every payload is Noise ciphertext; the relay sees routing metadata only (I1–I3). The
 * hub never decides by itself (I4): a request ends with a phone decision, the store's
 * deadline (whose `onExpire` behaviour belongs to the hook dispatcher) or a handoff.
 */
export function createSessionHub(options: SessionHubOptions): SessionHub {
  const { clock, random, store } = options;
  const log: HubLog = options.log ?? (() => undefined);
  let agentId: string | undefined;
  let peers: readonly Peer[] = [];
  let seq = 0;
  const live = new Map<string, PhoneSession>();
  const hashes = new Map<string, Promise<string>>();
  const winners = new Map<string, Winner>();
  const inbound = new Map<string, Promise<void>>();
  let outbound: Promise<void> = Promise.resolve();
  const work = new Set<Promise<void>>();

  function track(promise: Promise<void>): void {
    const tracked = promise.catch((error: unknown) => {
      log('hub_error', { message: error instanceof Error ? error.message : String(error) });
    });
    work.add(tracked);
    void tracked.finally(() => work.delete(tracked));
  }

  /** Runs `step` after every earlier outbound step: seq order = nonce order = send order. */
  function enqueue(step: () => Promise<void> | void): void {
    outbound = outbound.then(step).catch((error: unknown) => {
      log('send_failed', { message: error instanceof Error ? error.message : String(error) });
    });
    track(outbound);
  }

  /** Runs `step` after every earlier inbound step from the same phone. */
  function serialize(phoneId: string, step: () => Promise<void>): void {
    const previous = inbound.get(phoneId) ?? Promise.resolve();
    const next = previous.then(step);
    const settled = next.catch((error: unknown) => {
      log('inbound_failed', {
        phone_device_id: phoneId,
        message: error instanceof Error ? error.message : String(error),
      });
    });
    inbound.set(phoneId, settled);
    track(settled);
  }

  function hashOf(request: PendingRequest): Promise<string> {
    let hash = hashes.get(request.id);
    if (hash === undefined) {
      hash = pendingRequestHash(request);
      hashes.set(request.id, hash);
    }
    return hash;
  }

  function baseHeader(
    to: string,
    cls: Envelope['cls'],
    expiresAt: number | null,
    replyTo?: string,
  ): EnvelopeHeader {
    return {
      v: VERSION_TABLE.v,
      kind: 'data',
      id: uuidV7(clock, random),
      from: agentId!,
      to,
      session: null,
      cls,
      seq: seq++,
      ts: clock.now(),
      expiresAt,
      ...(replyTo === undefined ? {} : { replyTo }),
    };
  }

  function sendPlain(
    to: string,
    cls: Envelope['cls'],
    payload: Uint8Array,
    expiresAt: number | null,
  ) {
    if (agentId === undefined) return;
    options.send({ ...baseHeader(to, cls, expiresAt), payload: toBase64(payload) });
  }

  /** Encrypts and sends one message, unless the session ended meanwhile. */
  async function sendSealed(
    session: PhoneSession,
    message: AgentMessage,
    cls: Envelope['cls'],
    expiresAt: number | null,
    replyTo?: string,
  ): Promise<void> {
    if (agentId === undefined || live.get(session.phoneId) !== session) return;
    if (session.transport.closed) return;
    const head = baseHeader(session.phoneId, cls, expiresAt, replyTo);
    const ciphertext = await session.transport.encrypt(
      head,
      encoder.encode(JSON.stringify(message)),
    );
    options.send({ ...head, payload: toBase64(ciphertext) });
  }

  function endSession(phoneId: string, reason: string): void {
    const session = live.get(phoneId);
    if (session === undefined) return;
    session.transport.close();
    live.delete(phoneId);
    log('session_closed', { phone_device_id: phoneId, reason });
  }

  /** Permission requests the phones can show, oldest first. */
  function shownRequests(): PendingRequest[] {
    return store
      .list()
      .filter((request) => request.kind === 'permission')
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  function snapshot(views: readonly { request: PendingRequest }[]): AgentMessage {
    const sessionIds = [...new Set(views.map((view) => view.request.sessionId))].slice(0, 100);
    const sessions: Session[] = sessionIds.map((id) => ({
      id,
      machineId: agentId!,
      repositoryId: null,
      agent: 'claude-code',
      state: 'waiting',
      statusText: 'Waiting for approval',
      lastPrompt: null,
      lastAnswer: null,
      steps: [],
      changedFiles: [],
    }));
    return {
      t: 'snapshot',
      machine: { id: agentId!, ...options.machine, agents: [...options.capabilities] },
      sessions,
      pending: views.slice(0, 100).map((view) => view.request.id),
    };
  }

  /** The request message for a pending request, or `undefined` when the phone cannot show it. */
  async function requestMessage(request: PendingRequest): Promise<AgentMessage | undefined> {
    const view = approvalView(request, await hashOf(request));
    if (view === undefined) return undefined;
    return { t: 'request', request: view, ttlMs: Math.max(0, request.deadline - clock.now()) };
  }

  /** Re-reads `peers.json` at every handshake: a new pairing or a removal counts at once. */
  async function findPeer(phoneId: string): Promise<Peer | undefined> {
    peers = await options.listPeers();
    return peers.find((candidate) => candidate.deviceId === phoneId);
  }

  /** KK responder (D3): read msg1, write msg2, then hand the phone the pending state. */
  async function handshake(envelope: Envelope, message: Uint8Array): Promise<void> {
    const phoneId = envelope.from;
    const me = agentId;
    if (me === undefined) return;
    const peer = await findPeer(phoneId);
    const phoneKey = peer && fromBase64Url(peer.publicKey);
    if (peer === undefined || phoneKey === undefined) {
      log('handshake_refused', { phone_device_id: phoneId, reason: 'not_paired' });
      return;
    }
    let msg2: Uint8Array;
    let transport: TransportSession;
    try {
      const state = await HandshakeState.initialize({
        pattern: KK,
        initiator: false,
        prologue: sessionPrologue({
          userId: options.userId,
          phoneDeviceId: phoneId,
          agentDeviceId: me,
        }),
        random,
        staticKeyPair: options.deviceKey,
        remoteStaticPublicKey: phoneKey,
      });
      await state.readMessage(message);
      msg2 = await state.writeMessage();
      transport = TransportSession.fromHandshake(state.result());
    } catch {
      log('handshake_failed', { phone_device_id: phoneId });
      return;
    }
    // Every pending hash ready, so the hand-over below runs without a gap in which a new
    // request could slip past both the initial set and the live feed.
    for (;;) {
      const missing = shownRequests().filter((request) => !hashes.has(request.id));
      if (missing.length === 0) break;
      await Promise.all(missing.map(hashOf));
    }
    if (agentId !== me) return;
    endSession(phoneId, 'replaced');
    const session: PhoneSession = { phoneId, transport };
    const reply = new Uint8Array(msg2.length + 1);
    reply[0] = HANDSHAKE_TAG.kk;
    reply.set(msg2, 1);
    enqueue(() => sendPlain(phoneId, 'control', reply, null));
    const requests = shownRequests();
    enqueue(async () => {
      const views: { request: PendingRequest }[] = [];
      for (const request of requests) {
        if (store.get(request.id) === undefined) continue;
        const message = await requestMessage(request);
        if (message === undefined) continue;
        views.push({ request });
        await sendSealed(session, message, 'event', request.deadline);
      }
      await sendSealed(session, snapshot(views), 'event', null);
    });
    live.set(phoneId, session);
    log('session_open', { phone_device_id: phoneId, pending: requests.length });
  }

  function reply(
    session: PhoneSession,
    requestId: string,
    replyTo: string,
    result: { result: 'accepted' } | { result: 'rejected'; reason: string },
  ): void {
    enqueue(() =>
      sendSealed(
        session,
        { t: 'decision_result', requestId, ...result } as AgentMessage,
        'reply',
        null,
        replyTo,
      ),
    );
  }

  /** Decrypts a phone's command and runs the D7 checks; applies it at most once. */
  async function command(session: PhoneSession, envelope: Envelope): Promise<void> {
    let plaintext: Uint8Array;
    try {
      plaintext = await session.transport.decrypt(header(envelope), fromBase64(envelope.payload));
    } catch {
      // The counter cannot resynchronise: the phone must run a new handshake (D3).
      endSession(session.phoneId, 'decrypt_failed');
      return;
    }
    let parsed: ReturnType<typeof PhoneMessage.safeParse>;
    try {
      parsed = PhoneMessage.safeParse(JSON.parse(decoder.decode(plaintext)));
    } catch {
      parsed = PhoneMessage.safeParse(undefined);
    }
    if (!parsed.success) {
      log('message_refused', { phone_device_id: session.phoneId, reason: 'bad_message' });
      return;
    }
    const { decision } = parsed.data;
    const pending = store.get(decision.request_id);
    const requestHash =
      pending !== undefined && pending.kind === 'permission' ? await hashOf(pending) : undefined;
    const computed = await decisionHash(decision);
    // From here on synchronous: the checks and the store see the same state (decide-once).
    const request = store.get(decision.request_id);
    const shown = request !== undefined && request.kind === 'permission' ? request : undefined;
    const result = checkDecision({
      session: live.get(session.phoneId) === session,
      decision,
      from: envelope.from,
      envelopeDecisionHash: envelope.decisionHash,
      computedDecisionHash: computed,
      request:
        shown === undefined || requestHash === undefined || shown !== pending
          ? undefined
          : { requestHash, deadline: shown.deadline },
      ended: store.ended(decision.request_id),
      agentDeviceId: agentId ?? '',
      supportedKinds: M0_DECISION_KINDS,
      now: clock.now(),
    });
    if (!result.ok) {
      log('decision_rejected', {
        phone_device_id: session.phoneId,
        request_id: decision.request_id,
        reason: result.reason,
      });
      reply(session, decision.request_id, envelope.id, {
        result: 'rejected',
        reason: result.reason,
      });
      return;
    }
    const target = shown!;
    const outcome = decision.kind as Winner['outcome'];
    winners.set(target.id, { phoneId: session.phoneId, outcome });
    if (outcome === 'terminal') store.release(target.id, 'released');
    else store.resolve(target.id, options.decide(target, { behavior: outcome }));
    log('decision_applied', {
      phone_device_id: session.phoneId,
      request_id: target.id,
      kind: outcome,
    });
    reply(session, decision.request_id, envelope.id, { result: 'accepted' });
  }

  function added(request: PendingRequest, duplicate: boolean): void {
    if (request.kind !== 'permission') return;
    void hashOf(request).catch(() => undefined);
    if (agentId === undefined) return;
    for (const session of live.values()) {
      enqueue(async () => {
        if (store.get(request.id) !== request) return;
        const message = await requestMessage(request);
        if (message !== undefined) await sendSealed(session, message, 'request', request.deadline);
      });
    }
    if (duplicate) return;
    // A paired phone without a session gets a doorbell: an empty `cls: request` the
    // relay pushes when the phone is offline (03 §5.12). No plaintext leaves (I3).
    for (const peer of peers) {
      if (live.has(peer.deviceId)) continue;
      enqueue(() => sendPlain(peer.deviceId, 'request', new Uint8Array(0), request.deadline));
    }
  }

  function removed(request: PendingRequest, event: PendingEvent & { type: 'removed' }): void {
    if (request.kind !== 'permission') return;
    const winner = winners.get(request.id);
    winners.delete(request.id);
    const { outcome } = event;
    let message: AgentMessage;
    if (winner !== undefined) {
      message = { t: 'resolved', requestId: request.id, outcome: winner.outcome };
    } else if (outcome.type === 'handoff' && outcome.reason === 'deadline') {
      message = { t: 'expired', requestId: request.id };
    } else {
      message = { t: 'resolved', requestId: request.id, outcome: 'withdrawn' };
    }
    const sessions = [...live.values()].filter((session) => session.phoneId !== winner?.phoneId);
    enqueue(async () => {
      // A duplicate replaced the request under the same id: it is still pending.
      if (store.get(request.id) !== undefined) return;
      hashes.delete(request.id);
      for (const session of sessions) await sendSealed(session, message, 'event', null);
    });
  }

  return {
    relayReady(agentDeviceId, presence) {
      agentId = agentDeviceId;
      for (const entry of presence) {
        if (!entry.online) endSession(entry.deviceId, 'offline');
      }
      track(
        options.listPeers().then((list) => {
          peers = list;
        }),
      );
    },
    relayDown() {
      for (const phoneId of [...live.keys()]) endSession(phoneId, 'relay_down');
      agentId = undefined;
    },
    presence(presence) {
      if (!presence.online) endSession(presence.deviceId, 'offline');
    },
    envelope(envelope) {
      if (agentId === undefined || envelope.from === agentId) return;
      if (envelope.to !== null && envelope.to !== agentId) return;
      if (envelope.cls === 'control') {
        const bytes = fromBase64(envelope.payload);
        if (bytes[0] !== HANDSHAKE_TAG.kk) return;
        serialize(envelope.from, () => handshake(envelope, bytes.subarray(1)));
        return;
      }
      if (envelope.cls !== 'command') return;
      const session = live.get(envelope.from);
      if (session === undefined) {
        // Without a session the decision cannot even be read (D7 check 1: no_session).
        log('decision_rejected', { phone_device_id: envelope.from, reason: 'no_session' });
        return;
      }
      serialize(envelope.from, () => command(session, envelope));
    },
    pendingEvent(event) {
      if (event.type === 'added') added(event.request, event.duplicate);
      else removed(event.request, event);
    },
    async idle() {
      while (work.size > 0) await Promise.all([...work]);
    },
    sessions() {
      return [...live.keys()];
    },
  };
}
