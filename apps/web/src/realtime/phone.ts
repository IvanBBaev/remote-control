import { pairingFingerprint } from '@remote-control/crypto';
import type { Random } from '@remote-control/protocol';

import { RelayError } from '../auth/relay-api.js';
import type { EnrolledAgent, RelayApi } from '../auth/relay-api.js';
import type { KeyStore } from '../pairing/key-store.js';
import { normalizePairingCode, pairingSecrets } from '../pairing/pairing-code.js';
import type { Timer } from '../ports/timer.js';
import { createRealtimeClient, PairingTimeoutError } from './realtime-client.js';
import type { RealtimeClient } from './realtime-client.js';
import type { SocketFactory } from './relay-socket.js';
import { createRealtimeStore } from './realtime-store.js';
import type { RealtimeStore } from './realtime-store.js';

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
  readonly isVisible?: () => boolean;
  readonly onError?: (error: unknown) => void;
}

/** The phone's device-side services, behind the screens. */
export interface PhoneService {
  readonly realtime: RealtimeStore;
  /** The local clock the realtime client runs on, for labels such as "last seen". */
  now(): number;
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
  /** The live client, once connected (M0-21 sends decisions through it). */
  readonly client: RealtimeClient | undefined;
}

/** What the relay's pairing answers mean to the user (D6, M0-10). */
function pairingFailure(error: unknown): PairingError {
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
  let client: RealtimeClient | undefined;
  let connecting: Promise<void> | undefined;
  let userId: string | undefined;

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

  return {
    realtime,
    now: () => options.timer.now(),
    get client() {
      return client;
    },
    pairedCount: async () => (await keyStore.machines()).length,
    connect,
    disconnect() {
      client?.stop();
      client = undefined;
      connecting = undefined;
      userId = undefined;
    },
    wake() {
      if (client !== undefined) client.wake();
      // A connect that failed (e.g. started offline) is retried on the next wake.
      else if (userId !== undefined && connecting === undefined)
        connect(userId).catch(() => undefined);
    },
    enroll: (name) => relay.enrollAgent(name),
    async pair(code) {
      const normalized = normalizePairingCode(code);
      if (normalized === undefined) throw new PairingError('Enter all 12 characters of the code.');
      // Joining uses up the slot, so only join when the handshake can follow.
      const live = client;
      if (live === undefined || realtime.getState().connection !== 'open') {
        throw new PairingError('Not connected. Check your connection and try again.');
      }
      try {
        const { psk, codeHash } = await pairingSecrets(normalized);
        const { agentDeviceId } = await relay.joinPairing(codeHash);
        const result = await live.pair(agentDeviceId, psk, options.phoneName);
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
    },
  };
}
