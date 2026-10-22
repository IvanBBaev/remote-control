import { pairingFingerprint } from '@remote-control/crypto';
import {
  DECISION_TTL_SECONDS,
  VERSION_TABLE,
  encodeAnswerPayload,
  requestHash,
} from '@remote-control/protocol';
import type {
  AlwaysDestination,
  AnswerPayload,
  ApprovalRequest,
  CanonicalDecision,
  DecisionKind,
  PermissionMode,
  Question,
  Random,
  Repository,
} from '@remote-control/protocol';

import type { PasskeyKeys } from '../auth/passkey-keys.js';
import { RelayError } from '../auth/relay-api.js';
import type { EnrolledAgent, RelayApi } from '../auth/relay-api.js';
import type { AssertDecisionResult, DeleteAccountResult } from '../auth/results.js';
import type { KeyStore } from '../pairing/key-store.js';
import { normalizePairingCode, pairingSecrets, pskSecrets } from '../pairing/pairing-code.js';
import type { PairingSecrets } from '../pairing/pairing-code.js';
import { parsePairingQr } from '../pairing/qr-text.js';
import type { Timer, TimerHandle } from '../ports/timer.js';
import { uuidV7 } from './envelope.js';
import { createRealtimeClient, PairingTimeoutError } from './realtime-client.js';
import type { RealtimeClient, Signed } from './realtime-client.js';
import type { SocketFactory } from './relay-socket.js';
import { createRealtimeStore, diffKey } from './realtime-store.js';
import type { RealtimeStore } from './realtime-store.js';
import { createUsageStatsStore, memoryUsageStorage, trackUsage } from './usage-stats.js';
import type { UsageStatsStorage, UsageStatsStore } from './usage-stats.js';

/** A completed handshake waiting for the user to compare the fingerprint (D6). */
export interface PendingPairing {
  readonly agentDeviceId: string;
  /** The name the computer told the phone inside the handshake. */
  readonly name: string;
  /** `ABCD-EFGH`; the computer shows the same one. */
  readonly fingerprint: string;
  /** The user saw the same code on both screens: keep the pairing. */
  confirm(): Promise<void>;
}

/** A pairing step failed; `message` is written for the user. */
export class PairingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PairingError';
  }
}

export interface PhoneServiceOptions {
  readonly relay: RelayApi;
  readonly keyStore: KeyStore;
  readonly timer: Timer;
  readonly random: Random;
  readonly createSocket: SocketFactory;
  /** The relay's `/ws` URL. */
  readonly url: string;
  readonly version: string;
  /** How this phone is listed on the relay and on the computer. */
  readonly phoneName: string;
  /**
   * Binds a decision to a user-verified passkey assertion (D7): WebAuthn in the PWA, the
   * platform passkey or device key in the native app. Called from the tap handler.
   */
  readonly authorize: (decision: CanonicalDecision) => Promise<AssertDecisionResult>;
  /** Deletes the account behind a user-verified assertion over its deletion hash (M1-10). */
  readonly deleteAccount: (userId: string) => Promise<DeleteAccountResult>;
  /**
   * This phone's passkey public keys (M2-03), handed to a computer at pairing so its
   * agent checks every assertion itself; without them the relay's check stands.
   */
  readonly passkeys?: PasskeyKeys;
  readonly isVisible?: () => boolean;
  readonly onError?: (error: unknown) => void;
  /** Where the local usage counters persist (M1-11); default: memory only. */
  readonly usageStorage?: UsageStatsStorage;
}

/** A sent start or instruction: its `request_id` keys `realtime.commands` (M1-04). */
export type CommandResult = AssertDecisionResult & { readonly requestId: string };

/** The phone's device-side services, behind the screens. */
export interface PhoneService {
  readonly realtime: RealtimeStore;
  /** Local usage counters per computer and project; never leave this phone (M1-11). */
  readonly usage: UsageStatsStore;
  /** The local clock the realtime client runs on, for labels such as "last seen". */
  now(): number;
  /** Schedules on the same clock, for countdowns. */
  after(ms: number, callback: () => void): TimerHandle;
  /** How many computers this phone has paired, from the key store. */
  pairedCount(): Promise<number>;
  /** Binds this phone to the signed-in account and connects; repeated calls are no-ops. */
  connect(userId: string): Promise<void>;
  disconnect(): void;
  /** The app came back to the foreground or online; retries a failed connect. */
  wake(): void;
  /** Issues the one-time token for `remotectl login` on a new computer. */
  enroll(name: string): Promise<EnrolledAgent>;
  /** Joins the slot for `code` and runs the handshake; the user confirms the result. */
  pair(code: string): Promise<PendingPairing>;
  /** The same, from the scanned `rc1:` QR text with the full 32-byte key (M2-04). */
  pairScanned(text: string): Promise<PendingPairing>;
  /** The live client, once connected (M0-21 sends decisions through it). */
  readonly client: RealtimeClient | undefined;
  /**
   * Answers `request` on `machineId`: builds the canonical decision, asks for the passkey
   * assertion when the kind needs one (Allow, Always, D7), then queues it for the agent.
   * Call it from the tap handler, so iOS lets the passkey sheet open. For `always`,
   * `destination` is where the rules go (M2-07), signed in the payload; the session by
   * default.
   */
  decide(
    machineId: string,
    request: ApprovalRequest | Question,
    kind: 'allow' | 'always' | 'deny',
    destination?: AlwaysDestination,
  ): Promise<AssertDecisionResult>;
  /**
   * Answers an `AskUserQuestion` (M1-01): the answer rides in the decision's payload, so
   * the passkey assertion (always required for an answer, D7) signs exactly what was
   * picked. Call it from the tap handler, like `decide`.
   */
  answer(
    machineId: string,
    question: Question,
    answer: AnswerPayload,
  ): Promise<AssertDecisionResult>;
  /**
   * "Reply in terminal" (M1-03, D10): a sealed `terminal` decision that releases the
   * request, so Claude Code shows its own prompt. No passkey (D7), and it counts as
   * neither an approval nor a denial (M1-11).
   */
  release(machineId: string, request: ApprovalRequest | Question): Promise<AssertDecisionResult>;
  /**
   * Starts a session in one of the computer's allow-listed repositories (M1-04). Only the
   * repository id travels; the signed hash covers the prompt and the repository's path,
   * so the passkey assertion (D7) approves exactly this prompt in exactly that folder.
   * A permission mode other than `default` (M2-09) travels too and the hash covers it;
   * `default` is sent as no mode, which an agent before M2-09 also reads.
   * Call it from the tap handler, like `decide`.
   */
  start(
    machineId: string,
    repository: Repository,
    prompt: string,
    permissionMode?: PermissionMode,
  ): Promise<CommandResult>;
  /** Sends a follow-up prompt to a running session (M1-04), with a passkey assertion. */
  instruct(machineId: string, sessionId: string, text: string): Promise<CommandResult>;
  /**
   * Asks for a changed file's diff (M2-02); it lands in `realtime.diffs` under `diffKey`.
   * A read, so no passkey; `unavailable` right away when not connected.
   */
  diff(machineId: string, sessionId: string, file: string): void;
  /**
   * Deletes `userId`'s account behind a UV passkey assertion (M1-10), then forgets every
   * computer's keys here and disconnects. The caller signs out. Call it from the tap
   * handler, like `decide`.
   */
  deleteAccount(userId: string): Promise<DeleteAccountResult>;
}

/** What the relay's pairing answers mean to the user (D6, M0-10). */
function pairingFailure(error: unknown): PairingError {
  if (error instanceof PairingError) return error;
  if (error instanceof RelayError) {
    if (error.reason === 'unknown_slot')
      return new PairingError('That code is not valid. Check it and try again.', { cause: error });
    if (error.reason === 'expired' || error.reason === 'closed') {
      return new PairingError('That code has expired. Run `npx remotectl pair` again.', {
        cause: error,
      });
    }
    if (error.reason === 'already_joined') {
      return new PairingError('That code was already used. Run `npx remotectl pair` again.', {
        cause: error,
      });
    }
    if (error.status === 429)
      return new PairingError('Too many attempts. Wait a minute and try again.', { cause: error });
  }
  if (error instanceof PairingTimeoutError) {
    return new PairingError(
      'Your computer did not answer. Keep `npx remotectl pair` running and try again.',
      { cause: error },
    );
  }
  return new PairingError('Pairing failed. Try again.', { cause: error });
}

/** The relay's `/ws` endpoint on the origin that served the PWA (D1). */
export function relaySocketUrl(location: Pick<Location, 'protocol' | 'host'>): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

/** A short name for this phone from the user agent; the user never types it. */
export function phoneNameFrom(userAgent: string): string {
  if (/iPhone/.test(userAgent)) return 'iPhone';
  if (/iPad/.test(userAgent)) return 'iPad';
  if (/Android/.test(userAgent)) return 'Android phone';
  return 'Phone';
}

export function createPhoneService(options: PhoneServiceOptions): PhoneService {
  const { relay, keyStore } = options;
  const realtime = createRealtimeStore();
  const usage = createUsageStatsStore(options.usageStorage ?? memoryUsageStorage());
  /** Decisions sent and not yet answered, for the counters: request id → kind. */
  const sent = new Map<string, 'allow' | 'deny'>();
  trackUsage(realtime, usage, sent);
  let client: RealtimeClient | undefined;
  let connecting: Promise<void> | undefined;
  let userId: string | undefined;
  /** The id the relay bound this phone to on the current connection. */
  let phoneDeviceId: string | undefined;

  /** `POST /api/devices/phone`, keeping the id the relay already knows this phone by. */
  async function bind(): Promise<string> {
    const { deviceId } = await keyStore.identity();
    if (deviceId !== null) {
      try {
        return (await relay.bindPhone({ name: options.phoneName, deviceId })).deviceId;
      } catch (error) {
        // Revoked or from another account: become a new device.
        if (!(error instanceof RelayError && error.reason === 'unknown_device')) throw error;
      }
    }
    const bound = await relay.bindPhone({ name: options.phoneName });
    await keyStore.setDeviceId(bound.deviceId);
    return bound.deviceId;
  }

  async function open(forUser: string): Promise<void> {
    const deviceId = await bind();
    phoneDeviceId = deviceId;
    const { keyPair } = await keyStore.identity();
    client = createRealtimeClient({
      url: options.url,
      createSocket: options.createSocket,
      timer: options.timer,
      random: options.random,
      version: options.version,
      relay,
      keyStore,
      identity: { userId: forUser, deviceId, keyPair },
      store: realtime,
      ...(options.isVisible && { isVisible: options.isVisible }),
      ...(options.onError && { onError: options.onError }),
    });
    await client.start();
  }

  /**
   * Builds the canonical decision for `target`, asks for the passkey assertion when the
   * kind needs one (D7), then queues it for the agent.
   */
  async function send(
    machineId: string,
    target: Pick<ApprovalRequest, 'id' | 'requestHash'>,
    kind: DecisionKind,
    payload: string | null,
    deliver: (live: RealtimeClient, decision: CanonicalDecision, signed: Signed) => void = (
      live,
      decision,
      signed,
    ) => {
      live.decide(machineId, decision, signed);
    },
  ): Promise<AssertDecisionResult> {
    const live = client;
    if (live === undefined || phoneDeviceId === undefined) return { ok: false, failure: 'offline' };
    // Relay time: the clock both ends agree on, whatever the phone's own says (D7).
    const relayNow = options.timer.now() + realtime.getState().relayOffset;
    const issuedAt = Math.floor(relayNow / 1000);
    const decision: CanonicalDecision = {
      v: VERSION_TABLE.v,
      kind,
      request_id: target.id,
      request_hash: target.requestHash,
      payload,
      issued_at: issuedAt,
      expires_at: issuedAt + DECISION_TTL_SECONDS,
      phone_device_id: phoneDeviceId,
      agent_device_id: machineId,
    };
    const result = await options.authorize(decision);
    if (result.ok) {
      deliver(
        live,
        decision,
        result.asserted ? { decisionHash: result.decisionHash, assertion: result.assertion } : {},
      );
    }
    return result;
  }

  /** A new phone-originated request id: start and instruct have no agent request. */
  function newRequestId(): string {
    return uuidV7(options.timer.now() + realtime.getState().relayOffset, options.random);
  }

  function connect(forUser: string): Promise<void> {
    if (userId === forUser && connecting !== undefined) return connecting;
    client?.stop();
    client = undefined;
    userId = forUser;
    const attempt = open(forUser);
    connecting = attempt;
    // A failed attempt can be retried by calling `connect` again.
    attempt.catch(() => {
      if (connecting === attempt) connecting = undefined;
    });
    return attempt;
  }

  /**
   * Joins the slot and runs the handshake. Joining uses up the slot, so it only happens
   * when the handshake can follow.
   */
  async function handshake(
    secrets: () => Promise<PairingSecrets>,
    expectedAgent?: string,
  ): Promise<PendingPairing> {
    const live = client;
    if (live === undefined || realtime.getState().connection !== 'open') {
      throw new PairingError('Not connected. Check your connection and try again.');
    }
    try {
      const { psk, codeHash } = await secrets();
      const { agentDeviceId } = await relay.joinPairing(codeHash);
      if (
        expectedAgent !== undefined &&
        agentDeviceId.toLowerCase() !== expectedAgent.toLowerCase()
      ) {
        throw new PairingError(
          'That QR code does not match the computer. Run `npx remotectl pair` again.',
        );
      }
      const passkeys = userId === undefined ? [] : (options.passkeys?.list(userId) ?? []);
      const result = await live.pair(agentDeviceId, psk, {
        name: options.phoneName,
        ...(passkeys.length > 0 && { passkeys: [...passkeys] }),
      });
      const { keyPair } = await keyStore.identity();
      const fingerprint = await pairingFingerprint(keyPair.publicKey, result.publicKey);
      return {
        agentDeviceId,
        name: result.name,
        fingerprint,
        async confirm() {
          await keyStore.saveMachine({
            deviceId: agentDeviceId,
            name: result.name,
            publicKey: result.publicKey,
            pairedAt: options.timer.now(),
          });
          await live.reloadMachines();
        },
      };
    } catch (error) {
      throw pairingFailure(error);
    }
  }

  function disconnect(): void {
    client?.stop();
    client = undefined;
    phoneDeviceId = undefined;
    connecting = undefined;
    userId = undefined;
  }

  return {
    realtime,
    usage,
    now: () => options.timer.now(),
    after: (ms, callback) => options.timer.after(ms, callback),
    get client() {
      return client;
    },
    pairedCount: async () => (await keyStore.machines()).length,
    connect,
    disconnect,
    wake() {
      if (client !== undefined) client.wake();
      // A connect that failed (e.g. started offline) is retried on the next wake.
      else if (userId !== undefined && connecting === undefined)
        connect(userId).catch(() => undefined);
    },
    enroll: (name) => relay.enrollAgent(name),
    async deleteAccount(id) {
      const result = await options.deleteAccount(id);
      if (!result.ok) return result;
      disconnect();
      for (const machine of await keyStore.machines())
        await keyStore.removeMachine(machine.deviceId);
      return result;
    },
    async decide(machineId, request, kind, destination) {
      // The session is the signed default (`null`); a settings destination is named.
      const payload =
        kind === 'always' && destination !== undefined && destination !== 'session'
          ? destination
          : null;
      const result = await send(machineId, request, kind, payload);
      // "Always" counts as an approval, like the agent's counters (M2-05).
      if (result.ok) sent.set(request.id, kind === 'deny' ? 'deny' : 'allow');
      return result;
    },
    answer: (machineId, question, answer) =>
      send(machineId, question, 'answer', encodeAnswerPayload(answer)),
    release: (machineId, request) => send(machineId, request, 'terminal', null),
    async start(machineId, repository, prompt, picked) {
      const id = newRequestId();
      const permissionMode = picked === 'default' ? undefined : picked;
      const hash = await requestHash({ prompt, cwd: repository.path, permissionMode });
      const result = await send(
        machineId,
        { id, requestHash: hash },
        'start',
        repository.id,
        (live, decision, signed) => {
          const start = {
            machineId,
            repositoryId: repository.id,
            prompt,
            ...(permissionMode === undefined ? {} : { permissionMode }),
          };
          live.command(machineId, { t: 'start', start, decision }, signed);
        },
      );
      return { ...result, requestId: id };
    },
    async instruct(machineId, sessionId, text) {
      const id = newRequestId();
      const hash = await requestHash({ prompt: text, sessionId });
      const result = await send(
        machineId,
        { id, requestHash: hash },
        'instruct',
        text,
        (live, decision, signed) => {
          const instruction = { sessionId, text };
          live.command(machineId, { t: 'instruct', instruction, decision }, signed);
        },
      );
      return { ...result, requestId: id };
    },
    diff(machineId, sessionId, file) {
      if (client !== undefined) {
        client.requestDiff(machineId, sessionId, file);
        return;
      }
      const key = diffKey(machineId, sessionId, file);
      realtime.setState((state) => ({
        diffs: { ...state.diffs, [key]: { requestId: '', status: 'unavailable' } },
      }));
    },
    async pair(code) {
      const normalized = normalizePairingCode(code);
      if (normalized === undefined) throw new PairingError('Enter all 12 characters of the code.');
      return handshake(() => pairingSecrets(normalized));
    },
    async pairScanned(text) {
      const scanned = parsePairingQr(text);
      if (scanned === undefined) {
        throw new PairingError(
          'That is not a pairing QR code. Scan the one `remotectl pair` shows.',
        );
      }
      if (scanned.relayHost.toLowerCase() !== new URL(options.url).host.toLowerCase()) {
        throw new PairingError(
          `That QR code is for another server (${scanned.relayHost}). Check the computer's relay setting.`,
        );
      }
      return handshake(() => pskSecrets(scanned.psk), scanned.agentDeviceId);
    },
  };
}
