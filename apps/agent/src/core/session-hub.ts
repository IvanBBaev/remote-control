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
  EMPTY_CONTENT,
  fitSnapshot,
  HANDSHAKE_TAG,
  parseAnswerPayload,
  PhoneMessage,
  requestHash,
  VERSION_TABLE,
  type AgentMessage,
  type AlwaysDestination,
  type CanonicalDecision,
  type Capabilities,
  type Envelope,
  type FeedEvent,
  type Machine,
  type PresenceEntry,
  type Presence,
  type ProjectHistory,
  type Session,
  type StartSession,
} from '@remote-control/protocol';

import type { AdapterDecision, QuestionAnswers } from '../ports/agent-adapter.js';
import type { Clock } from '../ports/clock.js';
import type { Peer } from '../ports/key-store.js';
import type { Random } from '../ports/random.js';
import { approvalView, pendingRequestHash } from './approval-view.js';
import { checkCommand, type CommandTarget } from './command-check.js';
import { checkDecision, DECISION_KINDS } from './decision-check.js';
import { fromBase64Url } from './from-base64url.js';
import type { PendingEvent, PendingRequest, PendingStore } from './pending-store.js';
import { createPushSealer, pushSummaryText } from './push-summary.js';
import type { LaunchResult, SessionLauncher } from './launcher.js';
import { questionAnswers, questionView } from './question-view.js';
import { diffMessage, type StoredDiff } from './diff-store.js';
import type { FeedEntry } from './session-feed.js';
import { alwaysDestination, alwaysRules } from './session-rules.js';
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
  /**
   * Where "Always" may store rules (`always.destinations`, M2-07); the session when absent.
   * An `always` decision naming any other destination is refused (`wrong_kind`).
   */
  readonly alwaysDestinations?: readonly AlwaysDestination[];
  /** The machine as the snapshot shows it; `id` comes from the relay's `hello_ok`. */
  readonly machine: Omit<Machine, 'id' | 'agents'>;
  readonly capabilities: readonly Capabilities[];
  /**
   * The per-project history (M2-06), sent after every snapshot and on `historyChanged`;
   * without it no history is sent. A failed read skips that one message.
   */
  readonly history?: () => Promise<readonly ProjectHistory[]>;
  /**
   * Starts sessions and sends follow-ups (M1-04); without it `start` and `instruct` are
   * `unsupported`. The snapshot also lists its repositories and sessions.
   */
  readonly launcher?: SessionLauncher;
  /** A session's live feed content (M1-05), merged into the snapshot. */
  readonly feed?: (sessionId: string) => FeedEntry | undefined;
  /**
   * Setup facts for the phone's `/machines` checklist (M1-07); without it the snapshot
   * carries neither `hookSeen` nor `hooksInstalled`. A failed read leaves both out.
   */
  readonly setup?: () => Promise<SetupFacts>;
  /** A changed file's kept diff (M2-02), sent only when a phone asks for it. */
  readonly diff?: (sessionId: string, file: string) => StoredDiff | undefined;
  readonly log?: HubLog;
}

/** What `/machines` shows about this computer's setup (M1-07). */
export interface SetupFacts {
  /** Repository roots (as configured) a hook came from: Claude Code trusts them. */
  readonly hookSeen: ReadonlySet<string>;
  /** `remotectl hooks status` is complete; `undefined` when it could not be read. */
  readonly hooksInstalled: boolean | undefined;
}

/** The end-to-end side of the relay link: KK sessions per phone and decision intake. */
export interface SessionHub {
  /** The relay accepted the agent: its device id and who is online. */
  relayReady(agentDeviceId: string, presence: readonly PresenceEntry[]): void;
  /** The relay link is gone: every session ends (a session never outlives its link, D3). */
  relayDown(): void;
  presence(presence: Presence): void;
  /**
   * The relay revoked a phone (M1-10): its session ends and it is no longer a peer. The
   * caller removes it from `peers.json`; frames it still sends find no session.
   */
  peerRevoked(phoneId: string): void;
  /** A data envelope from the relay. */
  envelope(envelope: Envelope): void;
  /** Feed of the pending store (`onEvent`). */
  pendingEvent(event: PendingEvent): void;
  /**
   * A turn notice (M2-08) with its encoded summary: pushed to every paired phone without
   * a session. The caller checks that the user turned the notice on.
   */
  notice(summary: string): void;
  /** The history changed (a turn ended, a decision counted): every open session gets it. */
  historyChanged(): void;
  /** The sessions changed (registry): every open session gets a new snapshot. */
  sessionsChanged(): void;
  /** A session's live feed event (M1-05): every open session gets it. */
  feedEvent(sessionId: string, seq: number, event: FeedEvent): void;
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
type Winner = {
  readonly phoneId: string;
  readonly outcome: 'allow' | 'always' | 'deny' | 'terminal' | 'answer';
};

/** How long a turn notice's push stays deliverable (M2-08): stale news after that. */
export const NOTICE_TTL_MS = 15 * 60_000;

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
 * - New requests (permissions and questions, M1-01) go to every phone with a session; a paired phone without one
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
  const alwaysAllowed = options.alwaysDestinations ?? ['session'];
  let agentId: string | undefined;
  let peers: readonly Peer[] = [];
  /** Phones the relay revoked (M1-10); a re-paired phone gets a new device id. */
  const revoked = new Set<string>();
  const sealer = createPushSealer(options.deviceKey.privateKey, random);
  let seq = 0;
  const live = new Map<string, PhoneSession>();
  const hashes = new Map<string, Promise<string>>();
  const winners = new Map<string, Winner>();
  const inbound = new Map<string, Promise<void>>();
  let outbound: Promise<void> = Promise.resolve();
  const work = new Set<Promise<void>>();
  /** Accepted `start`/`instruct` request ids until their decision expires (decide-once). */
  const used = new Map<string, number>();
  const startSupported = options.capabilities.some((entry) => entry.startSession);
  const instructSupported = options.capabilities.some((entry) => entry.instructions);

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
    id = uuidV7(clock, random),
  ): EnvelopeHeader {
    return {
      v: VERSION_TABLE.v,
      kind: 'data',
      id,
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

  /**
   * The sealed push summary for one request envelope to `phoneId` (D5, M1-06), bound to
   * the envelope id. It rides in the header, so the transport AEAD authenticates it too.
   * Without a summary, a known peer or a key, the push stays generic.
   */
  async function pushBlobFor(
    phoneId: string,
    envelopeId: string,
    summary: string | undefined,
  ): Promise<{ pushBlob?: string }> {
    const peer = peers.find((candidate) => candidate.deviceId === phoneId);
    if (summary === undefined || peer === undefined) return {};
    const pushBlob = await sealer.seal(peer, envelopeId, summary);
    return pushBlob === undefined ? {} : { pushBlob };
  }

  /** The doorbell: an empty `cls: request` with only the sealed summary (03 §5.12). */
  async function sendDoorbell(to: string, request: PendingRequest): Promise<void> {
    const id = uuidV7(clock, random);
    const blob = await pushBlobFor(to, id, pushSummaryText(request));
    if (agentId === undefined) return;
    options.send({
      ...baseHeader(to, 'request', request.deadline, undefined, id),
      ...blob,
      payload: '',
    });
  }

  /**
   * A turn notice: like the doorbell, but nothing is pending. Without a sealed summary the
   * phone would show "Approval needed", so an unsealable notice is not sent at all.
   */
  async function sendNotice(to: string, summary: string, expiresAt: number): Promise<void> {
    const id = uuidV7(clock, random);
    const blob = await pushBlobFor(to, id, summary);
    if (agentId === undefined || blob.pushBlob === undefined) return;
    options.send({ ...baseHeader(to, 'request', expiresAt, undefined, id), ...blob, payload: '' });
  }

  /** Encrypts and sends one message, unless the session ended meanwhile. */
  async function sendSealed(
    session: PhoneSession,
    message: AgentMessage,
    cls: Envelope['cls'],
    expiresAt: number | null,
    replyTo?: string,
    summary?: string,
  ): Promise<void> {
    const id = uuidV7(clock, random);
    const blob = await pushBlobFor(session.phoneId, id, summary);
    if (agentId === undefined || live.get(session.phoneId) !== session) return;
    if (session.transport.closed) return;
    const head = { ...baseHeader(session.phoneId, cls, expiresAt, replyTo, id), ...blob };
    const ciphertext = await session.transport.encrypt(
      head,
      encoder.encode(JSON.stringify(message)),
    );
    options.send({ ...head, payload: toBase64(ciphertext) });
  }

  /** The current history to `sessions`, unless there is none to send. */
  async function sendHistory(sessions: readonly PhoneSession[]): Promise<void> {
    if (options.history === undefined || sessions.length === 0) return;
    let projects: ProjectHistory[];
    try {
      projects = [...(await options.history())];
    } catch {
      log('history_unavailable', {});
      return;
    }
    for (const session of sessions) {
      await sendSealed(session, { t: 'history', projects }, 'event', null);
    }
  }

  function endSession(phoneId: string, reason: string): void {
    const session = live.get(phoneId);
    if (session === undefined) return;
    session.transport.close();
    live.delete(phoneId);
    log('session_closed', { phone_device_id: phoneId, reason });
  }

  /** Pending requests the phones can show (permissions and questions), oldest first. */
  function shownRequests(): PendingRequest[] {
    return [...store.list()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * The snapshot: the launcher's repositories and sessions (M1-04), and every session
   * with a pending request shown as waiting for approval.
   */
  async function snapshot(views: readonly { request: PendingRequest }[]): Promise<AgentMessage> {
    const machineId = agentId!;
    const launcher = options.launcher;
    const known = launcher === undefined ? [] : await launcher.sessions();
    // Session id → the agent whose request waits (M2-01; absent = Claude Code).
    const waiting = new Map(
      views.map((view) => [view.request.sessionId, view.request.agent ?? 'claude-code']),
    );
    const sessions = new Map<string, Session>();
    const base = { machineId, agent: 'claude-code', ...EMPTY_CONTENT };
    // The feed content and the last event it includes, so a phone skips an event the
    // snapshot already shows.
    const content = (id: string) => {
      const entry = options.feed?.(id);
      return entry === undefined ? {} : { ...entry.content, feedSeq: entry.seq };
    };
    for (const [id, agent] of waiting) {
      sessions.set(id, {
        ...base,
        ...content(id),
        id,
        agent,
        repositoryId: null,
        state: 'waiting',
        statusText: 'Waiting for approval',
      });
    }
    for (const view of known) {
      const shown = waiting.has(view.id);
      sessions.set(view.id, {
        ...base,
        ...content(view.id),
        ...view,
        state: shown ? 'waiting' : view.state,
        statusText: shown ? 'Waiting for approval' : view.statusText,
      });
    }
    const setup = await options.setup?.().catch(() => undefined);
    const repositories =
      launcher === undefined
        ? undefined
        : (await launcher.repositories()).slice(0, 100).map((entry) => ({
            ...entry,
            machineId,
            ...(setup === undefined ? {} : { hookSeen: setup.hookSeen.has(entry.path) }),
          }));
    // The paired phones for `/machines` (M1-07): ids, names and dates, never a key.
    const devices = (await options.listPeers().catch(() => []))
      .filter((peer) => !revoked.has(peer.deviceId))
      .slice(0, 100)
      .map((peer) => ({ id: peer.deviceId, name: peer.name, pairedAt: peer.pairedAt }));
    // Content is thinned until the snapshot fits in one frame (M1-05 size cap).
    return fitSnapshot({
      t: 'snapshot',
      machine: { id: machineId, ...options.machine, agents: [...options.capabilities] },
      sessions: [...sessions.values()].slice(0, 100),
      pending: views.slice(0, 100).map((view) => view.request.id),
      ...(repositories === undefined ? {} : { repositories }),
      devices,
      ...(setup?.hooksInstalled === undefined ? {} : { hooksInstalled: setup.hooksInstalled }),
    });
  }

  /** The pending requests the phones can show right now. */
  async function shownViews(): Promise<{ request: PendingRequest }[]> {
    const views: { request: PendingRequest }[] = [];
    for (const request of shownRequests()) {
      if ((await requestMessage(request)) !== undefined) views.push({ request });
    }
    return views;
  }

  /** The request message for a pending request, or `undefined` when the phone cannot show it. */
  async function requestMessage(request: PendingRequest): Promise<AgentMessage | undefined> {
    const hash = await hashOf(request);
    const ttlMs = Math.max(0, request.deadline - clock.now());
    if (request.kind === 'question') {
      const question = questionView(request, hash);
      return question === undefined ? undefined : { t: 'question', question, ttlMs };
    }
    const view = approvalView(request, hash, alwaysAllowed);
    return view === undefined ? undefined : { t: 'request', request: view, ttlMs };
  }

  /** Re-reads `peers.json` at every handshake: a new pairing or a removal counts at once. */
  async function findPeer(phoneId: string): Promise<Peer | undefined> {
    peers = (await options.listPeers()).filter((peer) => !revoked.has(peer.deviceId));
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
      await sendSealed(session, await snapshot(views), 'event', null);
      await sendHistory([session]);
    });
    live.set(phoneId, session);
    log('session_open', { phone_device_id: phoneId, pending: requests.length });
  }

  function reply(
    session: PhoneSession,
    requestId: string,
    replyTo: string,
    result: { result: 'accepted'; sessionId?: string } | { result: 'rejected'; reason: string },
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
    if (parsed.data.t === 'diff_request') {
      // Read-only, so no passkey (D21); the answer goes to the asking phone alone.
      const message = diffMessage(
        parsed.data,
        options.diff?.(parsed.data.sessionId, parsed.data.file),
      );
      log('diff_sent', {
        phone_device_id: session.phoneId,
        request_id: parsed.data.requestId,
        found: message.patch !== null,
      });
      enqueue(() => sendSealed(session, message, 'reply', null, envelope.id));
      return;
    }
    if (parsed.data.t !== 'decision') {
      await launch(session, envelope, parsed.data);
      return;
    }
    const { decision } = parsed.data;
    const pending = store.get(decision.request_id);
    const requestHash = pending === undefined ? undefined : await hashOf(pending);
    const computed = await decisionHash(decision);
    // From here on synchronous: the checks and the store see the same state (decide-once).
    const shown = store.get(decision.request_id);
    let answer: QuestionAnswers | undefined;
    // `always` fits only a destination the user turned on, with rules to put there.
    const destination =
      decision.kind === 'always' ? alwaysDestination(decision.payload, alwaysAllowed) : undefined;
    if (decision.kind === 'answer' && shown !== undefined) {
      const payload = parseAnswerPayload(decision.payload);
      answer = payload === undefined ? undefined : questionAnswers(shown, payload);
    }
    const result = checkDecision({
      session: live.get(session.phoneId) === session,
      decision,
      from: envelope.from,
      envelopeDecisionHash: envelope.decisionHash,
      computedDecisionHash: computed,
      request:
        shown === undefined || requestHash === undefined || shown !== pending
          ? undefined
          : {
              kind: shown.kind,
              requestHash,
              deadline: shown.deadline,
              answerValid: answer !== undefined,
              alwaysSupported:
                destination !== undefined && alwaysRules(shown, destination).length > 0,
            },
      ended: store.ended(decision.request_id),
      agentDeviceId: agentId ?? '',
      supportedKinds: DECISION_KINDS,
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
    else if (outcome === 'answer') {
      store.resolve(target.id, options.decide(target, { behavior: outcome, answer: answer! }));
    } else if (outcome === 'always') {
      store.resolve(
        target.id,
        options.decide(target, { behavior: outcome, destination: destination! }),
      );
    } else store.resolve(target.id, options.decide(target, { behavior: outcome }));
    log('decision_applied', {
      phone_device_id: session.phoneId,
      request_id: target.id,
      kind: outcome,
    });
    reply(session, decision.request_id, envelope.id, { result: 'accepted' });
  }

  /**
   * A `start` or `instruct` command (M1-04): the D7 checks, then the launch. The launch
   * runs outside the phone's inbound queue, so the phone can still answer the new
   * session's requests while `claude` runs; the reply follows when it returns.
   */
  async function launch(
    session: PhoneSession,
    envelope: Envelope,
    message:
      | {
          t: 'start';
          start: StartSession;
          decision: CanonicalDecision;
        }
      | {
          t: 'instruct';
          instruction: { sessionId: string; text: string };
          decision: CanonicalDecision;
        },
  ): Promise<void> {
    const { decision } = message;
    const launcher = options.launcher;
    const now = clock.now();
    for (const [id, expiresAt] of used) if (expiresAt <= now) used.delete(id);
    let target: CommandTarget = { ok: false, reason: 'not_allowed' };
    if (launcher !== undefined && message.t === 'start') {
      const { repositoryId, prompt, permissionMode } = message.start;
      const repository = (await launcher.repositories()).find((entry) => entry.id === repositoryId);
      if (repository !== undefined) {
        // The picked mode is part of what the passkey signs (D7, M2-09).
        const subject = { prompt, cwd: repository.path, permissionMode };
        target = { ok: true, requestHash: await requestHash(subject) };
      }
    } else if (launcher !== undefined && message.t === 'instruct') {
      const { sessionId, text } = message.instruction;
      target = (await launcher.canFollowUp(sessionId))
        ? { ok: true, requestHash: await requestHash({ prompt: text, sessionId }) }
        : { ok: false, reason: 'follow_up_unsupported' };
    }
    const computed = await decisionHash(decision);
    const result = checkCommand({
      session: live.get(session.phoneId) === session,
      message: message.t,
      supported:
        launcher !== undefined && (message.t === 'start' ? startSupported : instructSupported),
      decision,
      payloadMatches:
        decision.payload ===
        (message.t === 'start' ? message.start.repositoryId : message.instruction.text),
      machineMatches: message.t !== 'start' || message.start.machineId === agentId,
      used: used.has(decision.request_id),
      from: envelope.from,
      envelopeDecisionHash: envelope.decisionHash,
      computedDecisionHash: computed,
      agentDeviceId: agentId ?? '',
      target,
      now: clock.now(),
    });
    if (!result.ok) {
      log('command_rejected', {
        phone_device_id: session.phoneId,
        request_id: decision.request_id,
        kind: message.t,
        reason: result.reason,
      });
      reply(session, decision.request_id, envelope.id, {
        result: 'rejected',
        reason: result.reason,
      });
      return;
    }
    used.set(decision.request_id, decision.expires_at * 1000);
    log('command_accepted', {
      phone_device_id: session.phoneId,
      request_id: decision.request_id,
      kind: message.t,
    });
    const run: Promise<LaunchResult> =
      message.t === 'start'
        ? launcher!.start(
            message.start.repositoryId,
            message.start.prompt,
            message.start.permissionMode,
          )
        : launcher!.instruct(message.instruction.sessionId, message.instruction.text);
    track(
      run.then((outcome) => {
        reply(
          session,
          decision.request_id,
          envelope.id,
          outcome.ok
            ? {
                result: 'accepted',
                ...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }),
              }
            : { result: 'rejected', reason: outcome.reason },
        );
      }),
    );
  }

  function added(request: PendingRequest, duplicate: boolean): void {
    void hashOf(request).catch(() => undefined);
    if (agentId === undefined) return;
    for (const session of live.values()) {
      enqueue(async () => {
        if (store.get(request.id) !== request) return;
        const message = await requestMessage(request);
        if (message === undefined) return;
        const summary = pushSummaryText(request);
        await sendSealed(session, message, 'request', request.deadline, undefined, summary);
      });
    }
    if (duplicate) return;
    // A paired phone without a session gets a doorbell: an empty `cls: request` the
    // relay pushes when the phone is offline (03 §5.12). No plaintext leaves (I3).
    for (const peer of peers) {
      if (live.has(peer.deviceId)) continue;
      enqueue(() => sendDoorbell(peer.deviceId, request));
    }
  }

  function removed(request: PendingRequest, event: PendingEvent & { type: 'removed' }): void {
    const winner = winners.get(request.id);
    winners.delete(request.id);
    const { outcome } = event;
    let message: AgentMessage;
    if (winner !== undefined) {
      // "Always" is an allow to the other phones; the rule lives in this session only.
      const outcome = winner.outcome === 'always' ? 'allow' : winner.outcome;
      message = { t: 'resolved', requestId: request.id, outcome };
    } else if (outcome.type === 'handoff' && outcome.reason === 'deadline') {
      message = { t: 'expired', requestId: request.id };
    } else if (outcome.type === 'handoff' && outcome.reason === 'paused') {
      // `remotectl pause` handed it back: the terminal answers it, like "Reply in terminal".
      message = { t: 'resolved', requestId: request.id, outcome: 'terminal' };
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

  /** Every open session gets a new snapshot. */
  function resnapshot(): void {
    if (agentId === undefined || live.size === 0) return;
    const sessions = [...live.values()];
    enqueue(async () => {
      const message = await snapshot(await shownViews());
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
          peers = list.filter((peer) => !revoked.has(peer.deviceId));
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
    peerRevoked(phoneId) {
      revoked.add(phoneId);
      endSession(phoneId, 'revoked');
      peers = peers.filter((peer) => peer.deviceId !== phoneId);
      // The other phones' `/machines` device list drops it at once.
      resnapshot();
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
    notice(summary) {
      if (agentId === undefined) return;
      const expiresAt = clock.now() + NOTICE_TTL_MS;
      for (const peer of peers) {
        if (live.has(peer.deviceId)) continue;
        enqueue(() => sendNotice(peer.deviceId, summary, expiresAt));
      }
    },
    historyChanged() {
      if (agentId === undefined || live.size === 0) return;
      enqueue(() => sendHistory([...live.values()]));
    },
    sessionsChanged: resnapshot,
    feedEvent(sessionId, seq, event) {
      if (agentId === undefined || live.size === 0) return;
      const sessions = [...live.values()];
      const message: AgentMessage = { t: 'event', sessionId, seq, event };
      enqueue(async () => {
        for (const session of sessions) await sendSealed(session, message, 'event', null);
      });
    },
    async idle() {
      while (work.size > 0) await Promise.all([...work]);
    },
    sessions() {
      return [...live.keys()];
    },
  };
}
