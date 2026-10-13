import {
  HandshakeState,
  KK,
  pairingPrologue,
  sessionPrologue,
  TransportSession,
  XXPSK0,
} from '@remote-control/crypto';
import type { X25519KeyPair } from '@remote-control/crypto';
import { AgentMessage, HANDSHAKE_TAG, PairingHello, VERSION_TABLE } from '@remote-control/protocol';
import type {
  CanonicalDecision,
  Envelope,
  Frame,
  HelloOk,
  PresenceEntry,
  Random,
} from '@remote-control/protocol';

import type { RelayApi } from '../auth/relay-api.js';
import type { KeyStore, PairedMachine } from '../pairing/key-store.js';
import type { Timer, TimerHandle } from '../ports/timer.js';
import { fromBase64, header, toBase64, uuidV7 } from './envelope.js';
import { createRelaySocket } from './relay-socket.js';
import type { SocketFactory } from './relay-socket.js';
import type { MachineView, RealtimeState, RealtimeStore, RequestUpdate } from './realtime-store.js';

/** Rec-5: after this many failed socket attempts, `/api/state` polling takes over. */
export const POLL_AFTER_FAILURES = 2;
export const POLL_INTERVAL_MS = 15_000;
/** How long the phone waits for the agent's half of the pairing handshake. */
export const PAIRING_TIMEOUT_MS = 60_000;

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
  readonly keyStore: Pick<KeyStore, 'machines'>;
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
  /** Runs the XXpsk0 initiator against the agent whose slot the phone joined (D6). */
  pair(agentDeviceId: string, psk: Uint8Array, phoneName: string): Promise<PairingResult>;
  /**
   * Queues a decision for the machine and sends it on the open session; it is re-sent on
   * every new session until the agent receives it, answers it, or it expires.
   */
  decide(machineId: string, decision: CanonicalDecision, decisionHash?: string): void;
}

interface Peer {
  paired: PairedMachine;
  kk?: HandshakeState;
  transport?: TransportSession;
}

interface Outgoing {
  readonly machineId: string;
  readonly decision: CanonicalDecision;
  readonly decisionHash?: string;
  /** The envelope it went out in last; a re-send uses a new one. */
  envelopeId?: string;
}

interface Pairing {
  readonly agentDeviceId: string;
  readonly state: HandshakeState;
  readonly phoneName: string;
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
  });

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
          }
        }
        return;
      case 'data':
        socket.send({ v: VERSION_TABLE.v, kind: 'ack', ids: [frame.id] });
        await onEnvelope(frame);
        return;
      /* v8 ignore next 2 -- the relay sends no other kind after hello_ok */
      default:
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
      const msg3 = await current.state.writeMessage(
        encoder.encode(JSON.stringify({ name: current.phoneName })),
      );
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
      case 'resolved':
        outbox.delete(message.requestId);
        updateRequest(message.requestId, { status: 'resolved', outcome: message.outcome });
        return;
      case 'expired':
        outbox.delete(message.requestId);
        updateRequest(message.requestId, { status: 'expired' });
        return;
      case 'decision_result':
        outbox.delete(message.requestId);
        updateRequest(message.requestId, { result: message });
        return;
    }
  }

  /** Sends every queued decision for the machine on its open session. */
  async function flush(machineId: string): Promise<void> {
    const peer = peers.get(machineId);
    if (peer?.transport === undefined) return;
    const now = timer.now();
    for (const [requestId, outgoing] of outbox) {
      if (outgoing.machineId !== machineId) continue;
      if (outgoing.decision.expires_at * 1000 <= now) {
        outbox.delete(requestId);
        continue;
      }
      const head = {
        ...envelope(machineId, 'command', EMPTY),
        ...(outgoing.decisionHash === undefined ? {} : { decisionHash: outgoing.decisionHash }),
      };
      const plaintext = encoder.encode(
        JSON.stringify({ t: 'decision', decision: outgoing.decision }),
      );
      const ciphertext = await peer.transport.encrypt(header(head), plaintext);
      if (socket.send({ ...head, payload: toBase64(ciphertext) })) outgoing.envelopeId = head.id;
    }
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
    async pair(agentDeviceId, psk, phoneName) {
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
        pairing = { agentDeviceId, state, phoneName, timeout, resolve, reject };
      });
      if (!control(agentDeviceId, HANDSHAKE_TAG.pairing, await state.writeMessage())) {
        pairing?.timeout.cancel();
        pairing = undefined;
        throw new Error('Not connected to the relay');
      }
      return result;
    },
    decide(machineId, decision, decisionHash) {
      outbox.set(decision.request_id, {
        machineId,
        decision,
        ...(decisionHash === undefined ? {} : { decisionHash }),
      });
      enqueue(() => flush(machineId));
    },
  };
}

export interface LifecycleTarget {
  readonly document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
  readonly window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

/**
 * Rec-5: a suspended tab's socket may be dead without a close event, so the client wakes
 * on `visibilitychange` (to visible), `pageshow` (bfcache restore) and `online`.
 */
export function bindLifecycle(
  client: Pick<RealtimeClient, 'wake'>,
  target: LifecycleTarget,
): () => void {
  const onVisibility = (): void => {
    if (target.document.visibilityState === 'visible') client.wake();
  };
  const wake = (): void => {
    client.wake();
  };
  target.document.addEventListener('visibilitychange', onVisibility);
  target.window.addEventListener('pageshow', wake);
  target.window.addEventListener('online', wake);
  return () => {
    target.document.removeEventListener('visibilitychange', onVisibility);
    target.window.removeEventListener('pageshow', wake);
    target.window.removeEventListener('online', wake);
  };
}
