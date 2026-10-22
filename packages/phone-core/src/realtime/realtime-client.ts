import {
  HandshakeState,
  KK,
  pairingPrologue,
  sessionPrologue,
  TransportSession,
  XXPSK0,
} from '@remote-control/crypto';
import type { X25519KeyPair } from '@remote-control/crypto';
import {
  AgentMessage,
  applyFeedEvent,
  HANDSHAKE_TAG,
  PairingHello,
  VERSION_TABLE,
} from '@remote-control/protocol';
import type {
  CanonicalDecision,
  DecisionAssertion,
  DiffRequestMessage,
  Envelope,
  Frame,
  HelloOk,
  InstructMessage,
  PhoneMessage,
  PhonePairingHello,
  PresenceEntry,
  Random,
  StartMessage,
} from '@remote-control/protocol';

import type { RelayApi } from '../auth/relay-api.js';
import type { KeyStore, PairedMachine } from '../pairing/key-store.js';
import type { Timer, TimerHandle } from '../ports/timer.js';
import { fromBase64, header, toBase64, uuidV7 } from './envelope.js';
import { createRelaySocket } from './relay-socket.js';
import type { SocketFactory } from './relay-socket.js';
import { diffKey } from './realtime-store.js';
import type {
  CommandView,
  DiffView,
  MachineView,
  RealtimeState,
  RealtimeStore,
  RequestUpdate,
} from './realtime-store.js';

/** Rec-5: after this many failed socket attempts, `/api/state` polling takes over. */
export const POLL_AFTER_FAILURES = 2;
export const POLL_INTERVAL_MS = 15_000;
/** How long the phone waits for the agent's half of the pairing handshake. */
export const PAIRING_TIMEOUT_MS = 60_000;
/** How long the phone waits for a diff (M2-02); an older agent never answers one. */
export const DIFF_TIMEOUT_MS = 15_000;

/** The agent never sent its half of the pairing handshake. */
export class PairingTimeoutError extends Error {
  constructor() {
    super('The computer did not answer');
    this.name = 'PairingTimeoutError';
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const EMPTY = new Uint8Array(0);

export interface RealtimeIdentity {
  readonly userId: string;
  readonly deviceId: string;
  readonly keyPair: X25519KeyPair;
}

export interface RealtimeClientOptions {
  readonly url: string;
  readonly createSocket: SocketFactory;
  readonly timer: Timer;
  readonly random: Random;
  /** The PWA build version, sent in `hello`. */
  readonly version: string;
  readonly relay: Pick<RelayApi, 'state'>;
  readonly keyStore: Pick<KeyStore, 'machines' | 'removeMachine'>;
  readonly identity: RealtimeIdentity;
  readonly store: RealtimeStore;
  /** Polling runs only while the app is in the foreground. */
  readonly isVisible?: () => boolean;
  /** A frame the client could not process (bad ciphertext, malformed message). */
  readonly onError?: (error: unknown) => void;
}

export interface PairingResult {
  /** The name the agent told the phone inside the handshake. */
  readonly name: string;
  /** The agent's static key, authenticated by the handshake. */
  readonly publicKey: Uint8Array;
  /** The handshake hash, for the fingerprint both screens show (D6). */
  readonly handshakeHash: Uint8Array;
}

export interface RealtimeClient {
  /** Loads the paired machines and connects. */
  start(): Promise<void>;
  stop(): void;
  /** The app came back to the foreground or the network returned. */
  wake(): void;
  /** Re-reads the key store, e.g. after a pairing was confirmed. */
  reloadMachines(): Promise<void>;
  /**
   * Runs the XXpsk0 initiator against the agent whose slot the phone joined (D6); msg3
   * carries `hello`, with this phone's passkey public keys (M2-03).
   */
  pair(agentDeviceId: string, psk: Uint8Array, hello: PhonePairingHello): Promise<PairingResult>;
  /**
   * Queues a decision for the machine and sends it on the open session; it is re-sent on
   * every new session until the agent receives it, answers it, or it expires.
   */
  decide(machineId: string, decision: CanonicalDecision, signed?: Signed): void;
  /**
   * Queues a session start or follow-up instruction (M1-04) like a decision, and tracks
   * it in the store's `commands` under its `request_id` until the agent answers.
   */
  command(machineId: string, message: StartMessage | InstructMessage, signed?: Signed): void;
  /**
   * Asks the machine for a changed file's diff (M2-02) on its open session, tracked in
   * the store's `diffs`. Not queued: without a session it is `unavailable` at once.
   */
  requestDiff(machineId: string, sessionId: string, file: string): void;
}

/** What proves a decision the passkey approved (D7); empty for Deny and "Reply in terminal". */
export interface Signed {
  /** The relay's check (phase 1), in the envelope head. */
  readonly decisionHash?: string | undefined;
  /** The agent's own check (phase 2, M2-03), sealed into the message. */
  readonly assertion?: DecisionAssertion | undefined;
}

/** A phone message that carries a D7 decision, so it can wait in the outbox. */
type QueuedMessage = Exclude<PhoneMessage, DiffRequestMessage>;

interface Peer {
  paired: PairedMachine;
  kk?: HandshakeState;
  transport?: TransportSession;
}

/** The outcome an accepted decision of this kind ends its request with. */
const ACCEPTED_OUTCOME: Partial<Record<CanonicalDecision['kind'], 'allow' | 'deny' | 'answer'>> = {
  allow: 'allow',
  always: 'allow',
  deny: 'deny',
  answer: 'answer',
};

interface Outgoing {
  readonly machineId: string;
  readonly message: QueuedMessage;
  readonly decisionHash?: string;
  /** The envelope it went out in last; a re-send uses a new one. */
  envelopeId?: string;
}

interface Pairing {
  readonly agentDeviceId: string;
  readonly state: HandshakeState;
  readonly hello: PhonePairingHello;
  readonly timeout: TimerHandle;
  resolve(result: PairingResult): void;
  reject(error: Error): void;
}

/**
 * The phone's live link to its machines (05 Rec-5, 02 §5): one relay socket, a Noise KK
 * session per paired machine re-run on every connection (D3), decrypted agent messages
 * into the store, acks, a decision outbox, and `/api/state` polling while the socket is
 * down.
 */
export function createRealtimeClient(options: RealtimeClientOptions): RealtimeClient {
  const { timer, random, identity, store } = options;
  const isVisible = options.isVisible ?? (() => true);
  const peers = new Map<string, Peer>();
  const outbox = new Map<string, Outgoing>();
  /** What this phone decided, by request id, until the agent answers it (an ack empties the outbox). */
  const decided = new Map<string, CanonicalDecision['kind']>();
  let pairing: Pairing | undefined;
  let seq = 0;
  let chain: Promise<void> = Promise.resolve();
  let pollTimer: TimerHandle | undefined;
  let running = false;

  const update = (change: (state: RealtimeState) => Partial<RealtimeState>): void => {
    store.setState(change);
  };

  const updateMachine = (deviceId: string, change: Partial<MachineView>): void => {
    update((state) => {
      const current = state.machines[deviceId];
      if (current === undefined) return {};
      return { machines: { ...state.machines, [deviceId]: { ...current, ...change } } };
    });
  };

  const updateRequest = (requestId: string, change: RequestUpdate): void => {
    update((state) => {
      const current = state.requests[requestId];
      if (current === undefined) return {};
      return { requests: { ...state.requests, [requestId]: { ...current, ...change } } };
    });
  };

  const updateCommand = (requestId: string, change: Partial<CommandView>): void => {
    update((state) => {
      const current = state.commands[requestId];
      if (current === undefined) return {};
      return { commands: { ...state.commands, [requestId]: { ...current, ...change } } };
    });
  };

  /** Changes the diff under `key` only while it still belongs to `requestId`. */
  const updateDiff = (key: string, requestId: string, change: Partial<DiffView>): void => {
    update((state) => {
      const current = state.diffs[key];
      if (current?.requestId !== requestId) return {};
      return { diffs: { ...state.diffs, [key]: { ...current, ...change } } };
    });
  };

  const confirm = (relayTs: number): void => {
    update(() => ({ relayOffset: relayTs - timer.now(), confirmedAt: relayTs }));
  };

  const fail = (error: unknown): void => {
    options.onError?.(error);
  };

  /** Frame work runs one at a time, in arrival order: KK and decryption are stateful. */
  const enqueue = (work: () => Promise<void> | void): void => {
    chain = chain.then(work).catch(fail);
  };

  const socket = createRelaySocket({
    url: options.url,
    createSocket: options.createSocket,
    timer,
    version: options.version,
    onOpen: (hello) => {
      enqueue(() => onHello(hello));
    },
    onFrame: (frame) => {
      enqueue(() => onFrame(frame));
    },
    onStatus: (status, failures) => {
      update(() => ({ connection: status, failures }));
      if (status !== 'open') resetSessions();
      if (status === 'open') stopPolling();
      else if (status !== 'stopped' && failures >= POLL_AFTER_FAILURES) startPolling();
    },
    onRevoked: (reason) => {
      enqueue(() => onRevoked(reason));
    },
  });

  /**
   * The relay revoked this phone or deleted the account (M1-10): every machine already
   * forgot this phone, so its keys go too, and the store tells the app to sign out.
   */
  async function onRevoked(reason: string): Promise<void> {
    running = false;
    stopPolling();
    for (const machine of await options.keyStore.machines()) {
      await options.keyStore.removeMachine(machine.deviceId);
    }
    update(() => ({
      revoked: reason === '' ? 'revoked' : reason,
      machines: {},
      requests: {},
      commands: {},
      diffs: {},
    }));
  }

  function envelope(to: string, cls: Envelope['cls'], payload: Uint8Array): Envelope {
    const now = timer.now();
    return {
      v: VERSION_TABLE.v,
      kind: 'data',
      id: uuidV7(now, random),
      from: identity.deviceId,
      to,
      session: null,
      cls,
      seq: seq++,
      ts: now,
      expiresAt: null,
      payload: toBase64(payload),
    };
  }

  function control(to: string, tag: number, message: Uint8Array): boolean {
    const bytes = new Uint8Array(message.length + 1);
    bytes[0] = tag;
    bytes.set(message, 1);
    return socket.send(envelope(to, 'control', bytes));
  }

  function dropSession(peer: Peer): void {
    peer.transport?.close();
    peer.transport = undefined;
    peer.kk = undefined;
    updateMachine(peer.paired.deviceId, { session: 'none' });
  }

  function resetSessions(): void {
    for (const peer of peers.values()) {
      if (peer.kk !== undefined || peer.transport !== undefined) dropSession(peer);
    }
  }

  /** The KK initiator (D3): a fresh session on every connection, never resumed. */
  async function handshake(peer: Peer): Promise<void> {
    dropSession(peer);
    const agentDeviceId = peer.paired.deviceId;
    const kk = await HandshakeState.initialize({
      pattern: KK,
      initiator: true,
      prologue: sessionPrologue({
        userId: identity.userId,
        phoneDeviceId: identity.deviceId,
        agentDeviceId,
      }),
      random,
      staticKeyPair: identity.keyPair,
      remoteStaticPublicKey: peer.paired.publicKey,
    });
    if (!control(agentDeviceId, HANDSHAKE_TAG.kk, await kk.writeMessage())) return;
    peer.kk = kk;
    updateMachine(agentDeviceId, { session: 'handshaking' });
  }

  function presence(entries: readonly PresenceEntry[]): void {
    update((state) => {
      const machines = { ...state.machines };
      for (const id of Object.keys(machines)) {
        const entry = entries.find((candidate) => candidate.deviceId === id);
        machines[id] = {
          ...machines[id]!,
          online: entry?.online ?? false,
          lastSeen: entry?.lastSeen ?? machines[id]!.lastSeen,
        };
      }
      return { machines };
    });
  }

  async function onHello(hello: HelloOk): Promise<void> {
    confirm(hello.relayTs);
    presence(hello.presence);
    for (const entry of hello.presence) {
      const peer = peers.get(entry.deviceId);
      if (peer !== undefined && entry.online) await handshake(peer);
    }
  }

  async function onFrame(frame: Exclude<Frame, HelloOk>): Promise<void> {
    switch (frame.kind) {
      case 'pong':
        confirm(frame.relayTs);
        return;
      case 'presence': {
        update((state) => ({
          confirmedAt: Math.max(state.confirmedAt ?? frame.at, frame.at),
        }));
        const peer = peers.get(frame.deviceId);
        if (peer === undefined) return;
        updateMachine(frame.deviceId, { online: frame.online, lastSeen: frame.at });
        if (frame.online) await handshake(peer);
        else dropSession(peer);
        return;
      }
      case 'ack':
        for (const [requestId, outgoing] of outbox) {
          if (outgoing.envelopeId !== undefined && frame.ids.includes(outgoing.envelopeId)) {
            outbox.delete(requestId);
          }
        }
        return;
      case 'error':
        for (const [requestId, outgoing] of outbox) {
          if (outgoing.envelopeId === frame.ref) {
            outbox.delete(requestId);
            updateRequest(requestId, { relayError: frame.code });
            updateCommand(requestId, { relayError: frame.code });
          }
        }
        return;
      case 'data':
        socket.send({ v: VERSION_TABLE.v, kind: 'ack', ids: [frame.id] });
        await onEnvelope(frame);
        return;
      case 'hello':
      case 'ping':
        return;
    }
  }

  async function onEnvelope(received: Envelope): Promise<void> {
    const bytes = fromBase64(received.payload);
    if (received.cls === 'control') {
      if (bytes[0] === HANDSHAKE_TAG.kk) await onKk(received.from, bytes.subarray(1));
      else if (bytes[0] === HANDSHAKE_TAG.pairing)
        await onPairing(received.from, bytes.subarray(1));
      return;
    }
    // An empty `cls: request` envelope is a doorbell: the session brings the content.
    if (bytes.length === 0) return;
    const peer = peers.get(received.from);
    if (peer?.transport === undefined) return;
    let message: AgentMessage;
    try {
      const plaintext = await peer.transport.decrypt(header(received), bytes);
      message = AgentMessage.parse(JSON.parse(decoder.decode(plaintext)));
    } catch (error) {
      // The counter cannot resynchronise: start over with a new handshake.
      await handshake(peer);
      throw error;
    }
    apply(received.from, message);
  }

  async function onKk(from: string, message: Uint8Array): Promise<void> {
    const peer = peers.get(from);
    if (peer?.kk === undefined) return;
    const kk = peer.kk;
    peer.kk = undefined;
    await kk.readMessage(message);
    peer.transport = TransportSession.fromHandshake(kk.result());
    updateMachine(from, { session: 'open' });
    await flush(from);
  }

  async function onPairing(from: string, message: Uint8Array): Promise<void> {
    const current = pairing;
    if (current?.agentDeviceId !== from) return;
    pairing = undefined;
    current.timeout.cancel();
    try {
      const hello = PairingHello.parse(
        JSON.parse(decoder.decode(await current.state.readMessage(message))),
      );
      const msg3 = await current.state.writeMessage(encoder.encode(JSON.stringify(current.hello)));
      if (!control(from, HANDSHAKE_TAG.pairing, msg3)) throw new Error('relay socket closed');
      const result = current.state.result();
      current.resolve({
        name: hello.name,
        publicKey: current.state.remoteStaticPublicKey!,
        handshakeHash: result.handshakeHash,
      });
    } catch (error) {
      current.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  function apply(machineId: string, message: AgentMessage): void {
    switch (message.t) {
      case 'request':
        update((state) => ({
          requests: {
            ...state.requests,
            [message.request.id]: {
              machineId,
              request: message.request,
              deadline: timer.now() + message.ttlMs,
              status: 'pending',
            },
          },
        }));
        return;
      case 'question':
        update((state) => ({
          requests: {
            ...state.requests,
            [message.question.id]: {
              machineId,
              kind: 'question',
              request: message.question,
              deadline: timer.now() + message.ttlMs,
              status: 'pending',
            },
          },
        }));
        return;
      case 'snapshot': {
        const pending = new Set(message.pending);
        update((state) => ({
          machines: {
            ...state.machines,
            [machineId]: {
              ...state.machines[machineId]!,
              name: message.machine.name,
              machine: message.machine,
              sessions: message.sessions,
              repositories: message.repositories ?? [],
              devices: message.devices ?? [],
              hooksInstalled: message.hooksInstalled,
            },
          },
          // Anything this machine no longer has pending is gone from the agent (D4).
          requests: Object.fromEntries(
            Object.entries(state.requests).filter(
              ([id, view]) =>
                view.machineId !== machineId || view.status !== 'pending' || pending.has(id),
            ),
          ),
        }));
        return;
      }
      case 'event':
        update((state) => {
          const machine = state.machines[machineId];
          const session = machine?.sessions.find((s) => s.id === message.sessionId);
          // A snapshot built after this event already holds it (M1-05).
          if (session === undefined || message.seq <= (session.feedSeq ?? 0)) return {};
          const next = { ...applyFeedEvent(session, message.event), feedSeq: message.seq };
          return {
            machines: {
              ...state.machines,
              [machineId]: {
                ...machine!,
                sessions: machine!.sessions.map((s) => (s === session ? next : s)),
              },
            },
          };
        });
        return;
      case 'history':
        updateMachine(machineId, { history: message.projects });
        return;
      case 'resolved':
        decided.delete(message.requestId);
        outbox.delete(message.requestId);
        updateRequest(message.requestId, { status: 'resolved', outcome: message.outcome });
        return;
      case 'expired':
        decided.delete(message.requestId);
        outbox.delete(message.requestId);
        updateRequest(message.requestId, { status: 'expired' });
        return;
      case 'decision_result': {
        const kind = decided.get(message.requestId);
        decided.delete(message.requestId);
        outbox.delete(message.requestId);
        // `resolved` goes to the other phones only (03 §6): the winner learns its own
        // outcome from the acceptance. "Reply in terminal" keeps its own released state.
        const outcome = message.result === 'accepted' ? kind && ACCEPTED_OUTCOME[kind] : undefined;
        updateRequest(message.requestId, {
          result: message,
          ...(outcome === undefined ? {} : { status: 'resolved', outcome }),
        });
        updateCommand(message.requestId, { result: message });
        return;
      }
      case 'diff': {
        const key = diffKey(machineId, message.sessionId, message.file);
        updateDiff(
          key,
          message.requestId,
          message.patch === null
            ? { status: 'unavailable' }
            : { status: 'ready', patch: message.patch, truncated: message.truncated },
        );
        return;
      }
    }
  }

  async function sendDiffRequest(machineId: string, message: DiffRequestMessage): Promise<void> {
    const key = diffKey(machineId, message.sessionId, message.file);
    const transport = peers.get(machineId)?.transport;
    if (transport !== undefined) {
      // A read, so no `decisionHash`: the relay passes it without a passkey (D21).
      const head = envelope(machineId, 'command', EMPTY);
      const ciphertext = await transport.encrypt(
        header(head),
        encoder.encode(JSON.stringify(message)),
      );
      if (socket.send({ ...head, payload: toBase64(ciphertext) })) return;
    }
    updateDiff(key, message.requestId, { status: 'unavailable' });
  }

  /** Sends every queued decision for the machine on its open session. */
  async function flush(machineId: string): Promise<void> {
    const peer = peers.get(machineId);
    if (peer?.transport === undefined) return;
    const now = timer.now();
    for (const [requestId, outgoing] of outbox) {
      if (outgoing.machineId !== machineId) continue;
      if (outgoing.message.decision.expires_at * 1000 <= now) {
        outbox.delete(requestId);
        updateCommand(requestId, { relayError: 'expired' });
        continue;
      }
      const head = {
        ...envelope(machineId, 'command', EMPTY),
        ...(outgoing.decisionHash === undefined ? {} : { decisionHash: outgoing.decisionHash }),
      };
      const plaintext = encoder.encode(JSON.stringify(outgoing.message));
      const ciphertext = await peer.transport.encrypt(header(head), plaintext);
      if (socket.send({ ...head, payload: toBase64(ciphertext) })) outgoing.envelopeId = head.id;
    }
  }

  function queue(machineId: string, message: QueuedMessage, signed: Signed): void {
    const { decisionHash, assertion } = signed;
    decided.set(message.decision.request_id, message.decision.kind);
    outbox.set(message.decision.request_id, {
      machineId,
      message: assertion === undefined ? message : { ...message, assertion },
      ...(decisionHash === undefined ? {} : { decisionHash }),
    });
    enqueue(() => flush(machineId));
  }

  async function poll(): Promise<void> {
    pollTimer = undefined;
    try {
      const state = await options.relay.state();
      confirm(state.relayTs);
      update((current) => {
        const machines = { ...current.machines };
        for (const device of state.devices) {
          const machine = machines[device.deviceId];
          if (machine === undefined) continue;
          machines[device.deviceId] = {
            ...machine,
            online: device.online,
            lastSeen: device.lastSeen ?? machine.lastSeen,
          };
        }
        return { machines };
      });
    } catch (error) {
      // Offline or relay down: the label goes stale on its own; try again next round.
      fail(error);
    }
    if (store.getState().polling && pollTimer === undefined) scheduleNextPoll();
  }

  function scheduleNextPoll(): void {
    pollTimer = timer.after(POLL_INTERVAL_MS, () => {
      if (isVisible()) void poll();
      else scheduleNextPoll();
    });
  }

  function startPolling(): void {
    if (store.getState().polling) return;
    update(() => ({ polling: true }));
    void poll();
  }

  function stopPolling(): void {
    pollTimer?.cancel();
    pollTimer = undefined;
    if (store.getState().polling) update(() => ({ polling: false }));
  }

  async function reloadMachines(): Promise<void> {
    const paired = await options.keyStore.machines();
    const known = new Set(paired.map((machine) => machine.deviceId));
    for (const [id, peer] of peers) {
      if (!known.has(id)) {
        dropSession(peer);
        peers.delete(id);
      }
    }
    const added: Peer[] = [];
    for (const machine of paired) {
      const peer = peers.get(machine.deviceId);
      if (peer === undefined) {
        const created: Peer = { paired: machine };
        peers.set(machine.deviceId, created);
        added.push(created);
      } else {
        peer.paired = machine;
      }
    }
    update((state) => ({
      machines: Object.fromEntries(
        paired.map((machine) => [
          machine.deviceId,
          state.machines[machine.deviceId] ?? {
            deviceId: machine.deviceId,
            name: machine.name,
            online: false,
            lastSeen: null,
            session: 'none',
            machine: null,
            sessions: [],
            history: null,
            repositories: [],
          },
        ]),
      ),
      requests: Object.fromEntries(
        Object.entries(state.requests).filter(([, view]) => known.has(view.machineId)),
      ),
    }));
    // A machine paired on this connection is online (it just answered): open its session.
    if (socket.status === 'open') {
      for (const peer of added) enqueue(() => handshake(peer));
    }
  }

  return {
    async start() {
      if (running) return;
      running = true;
      update(() => ({ revoked: null }));
      await reloadMachines();
      socket.start();
    },
    stop() {
      running = false;
      socket.stop();
      stopPolling();
      resetSessions();
      if (pairing !== undefined) {
        pairing.timeout.cancel();
        pairing.reject(new Error('realtime client stopped'));
        pairing = undefined;
      }
    },
    wake() {
      socket.wake();
      if (store.getState().polling) {
        pollTimer?.cancel();
        void poll();
      }
    },
    reloadMachines,
    async pair(agentDeviceId, psk, hello) {
      if (socket.status !== 'open') throw new Error('Not connected to the relay');
      pairing?.reject(new Error('Pairing replaced'));
      pairing?.timeout.cancel();
      const state = await HandshakeState.initialize({
        pattern: XXPSK0,
        initiator: true,
        prologue: pairingPrologue({ userId: identity.userId, agentDeviceId }),
        random,
        staticKeyPair: identity.keyPair,
        psk,
      });
      const result = new Promise<PairingResult>((resolve, reject) => {
        const timeout = timer.after(PAIRING_TIMEOUT_MS, () => {
          if (pairing?.state !== state) return;
          pairing = undefined;
          reject(new PairingTimeoutError());
        });
        pairing = { agentDeviceId, state, hello, timeout, resolve, reject };
      });
      if (!control(agentDeviceId, HANDSHAKE_TAG.pairing, await state.writeMessage())) {
        pairing?.timeout.cancel();
        pairing = undefined;
        throw new Error('Not connected to the relay');
      }
      return result;
    },
    decide(machineId, decision, signed = {}) {
      queue(machineId, { t: 'decision', decision }, signed);
    },
    command(machineId, message, signed = {}) {
      const view: CommandView =
        message.t === 'start'
          ? {
              machineId,
              kind: 'start',
              target: message.start.repositoryId,
              text: message.start.prompt,
            }
          : {
              machineId,
              kind: 'instruct',
              target: message.instruction.sessionId,
              text: message.instruction.text,
            };
      update((state) => ({
        commands: { ...state.commands, [message.decision.request_id]: view },
      }));
      queue(machineId, message, signed);
    },
    requestDiff(machineId, sessionId, file) {
      const requestId = uuidV7(timer.now(), random);
      const key = diffKey(machineId, sessionId, file);
      update((state) => ({
        diffs: { ...state.diffs, [key]: { requestId, status: 'loading' } },
      }));
      timer.after(DIFF_TIMEOUT_MS, () => {
        if (store.getState().diffs[key]?.status === 'loading') {
          updateDiff(key, requestId, { status: 'unavailable' });
        }
      });
      enqueue(() => sendDiffRequest(machineId, { t: 'diff_request', requestId, sessionId, file }));
    },
  };
}
