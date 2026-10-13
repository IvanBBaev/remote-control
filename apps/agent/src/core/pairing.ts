import {
  HandshakeState,
  pairingFingerprint,
  pairingPrologue,
  XXPSK0,
  type X25519KeyPair,
} from '@remote-control/crypto';
import {
  HANDSHAKE_TAG,
  PairingHello,
  toBase64Url,
  VERSION_TABLE,
  type Envelope,
} from '@remote-control/protocol';

import type { Clock } from '../ports/clock.js';
import type { Peer } from '../ports/key-store.js';
import type { Prompt } from '../ports/prompt.js';
import type { Random } from '../ports/random.js';
import type { RelayApi } from '../ports/relay-api.js';
import type { Timer } from '../ports/timer.js';
import type { WebSocketFactory } from '../ports/web-socket.js';
import {
  formatPairingCode,
  generatePairingCode,
  pairingPsk,
  pairingQrText,
  slotCodeHash,
} from './pairing-code.js';
import { createRelayClient } from './relay-client.js';
import { uuidV7 } from './uuid.js';

/** How often a fresh code is tried when the relay says `code_in_use`. */
const OPEN_ATTEMPTS = 5;

export interface PairingOptions {
  readonly clock: Clock;
  readonly random: Random;
  readonly timer: Timer;
  readonly userId: string;
  readonly deviceKey: X25519KeyPair;
  /** The name the phone shows for this agent (`PairingHello`). */
  readonly agentName: string;
  /** The relay host for the `rc1:` QR text. */
  readonly relayHost: string;
  readonly wsUrl: string;
  readonly token: string;
  readonly version: string;
  readonly webSocket: WebSocketFactory;
  readonly api: RelayApi;
  readonly prompt: Prompt;
  /** Terminal output, one line at a time. */
  readonly print: (line: string) => void;
  readonly addPeer: (peer: Peer) => Promise<void>;
  readonly signal: AbortSignal;
}

export type PairingOutcome =
  | { readonly status: 'paired'; readonly peer: Peer; readonly fingerprint: string }
  | { readonly status: 'declined' }
  | {
      readonly status: 'failed';
      readonly reason: 'attempts' | 'expired' | 'aborted' | 'relay';
      readonly detail?: string;
    };

interface Inbox {
  push(envelope: Envelope): void;
  /** The next pairing control envelope, or `undefined` when `stop` fires first. */
  next(): Promise<Envelope | undefined>;
  stop(): void;
}

function inbox(): Inbox {
  const queue: Envelope[] = [];
  let waiter: ((envelope: Envelope | undefined) => void) | undefined;
  let stopped = false;
  return {
    push(envelope) {
      if (waiter !== undefined) {
        const wake = waiter;
        waiter = undefined;
        wake(envelope);
      } else queue.push(envelope);
    },
    next() {
      if (stopped) return Promise.resolve(undefined);
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve) => (waiter = resolve));
    },
    stop() {
      stopped = true;
      waiter?.(undefined);
      waiter = undefined;
    },
  };
}

function handshakeBytes(envelope: Envelope): Uint8Array | undefined {
  if (envelope.cls !== 'control') return undefined;
  const bytes = new Uint8Array(Buffer.from(envelope.payload, 'base64'));
  return bytes[0] === HANDSHAKE_TAG.pairing ? bytes.subarray(1) : undefined;
}

/**
 * `remotectl pair` (D6, 02 §5.3): opens a pairing slot on the relay, prints the
 * 12-character code and the `rc1:` QR text, runs the XXpsk0 responder against the phone
 * that joined the slot, shows the fingerprint for the user to compare, and on a yes
 * completes the slot and stores the phone in `peers.json`. A failed handshake counts on
 * the relay; the third one closes the slot and ends the pairing.
 *
 * The PSK never leaves this process except inside the QR text on the user's own screen;
 * the relay gets only `HKDF(psk, "rc/v1/pair-slot")` (I3).
 */
export async function runPairing(options: PairingOptions): Promise<PairingOutcome> {
  const { api, print, random, clock } = options;
  const envelopes = inbox();
  let agentId: string | undefined;
  let ready: (() => void) | undefined;
  const readyPromise = new Promise<void>((resolve) => (ready = resolve));
  let seq = 0;
  const client = createRelayClient({
    url: options.wsUrl,
    token: options.token,
    version: options.version,
    webSocket: options.webSocket,
    timer: options.timer,
    random,
    onReady(helloOk) {
      agentId = helloOk.deviceId;
      ready?.();
    },
    onEnvelope: (envelope) => {
      if (handshakeBytes(envelope) !== undefined) envelopes.push(envelope);
    },
  });

  let slotId: string | undefined;
  let expiry: { cancel(): void } | undefined;
  let finished = false;
  let failure: PairingOutcome | undefined;
  const stopAll = (outcome: PairingOutcome) => {
    failure ??= outcome;
    envelopes.stop();
  };
  const onAbort = () => stopAll({ status: 'failed', reason: 'aborted' });
  options.signal.addEventListener('abort', onAbort);

  function reply(to: string, message: Uint8Array): void {
    const bytes = new Uint8Array(message.length + 1);
    bytes[0] = HANDSHAKE_TAG.pairing;
    bytes.set(message, 1);
    client.send({
      v: VERSION_TABLE.v,
      kind: 'data',
      id: uuidV7(clock, random),
      from: agentId!,
      to,
      session: null,
      cls: 'control',
      seq: seq++,
      ts: clock.now(),
      expiresAt: null,
      payload: Buffer.from(bytes).toString('base64'),
    });
  }

  /** The next pairing message from `phoneId`; others are ignored. */
  async function nextFrom(phoneId: string | undefined): Promise<Envelope | undefined> {
    for (;;) {
      const envelope = await envelopes.next();
      if (envelope === undefined) return undefined;
      if (phoneId === undefined || envelope.from === phoneId) return envelope;
    }
  }

  try {
    if (options.signal.aborted) return { status: 'failed', reason: 'aborted' };
    client.start();
    await Promise.race([
      readyPromise,
      new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve())),
    ]);
    if (failure !== undefined) return failure;

    let psk: Uint8Array | undefined;
    let code = '';
    for (let i = 0; i < OPEN_ATTEMPTS && slotId === undefined; i++) {
      code = generatePairingCode(random);
      psk = await pairingPsk(code);
      const opened = await api.openSlot(await slotCodeHash(psk));
      if (opened.ok) {
        slotId = opened.value.slotId;
        const left = Math.max(0, opened.value.expiresAt - clock.now());
        expiry = options.timer.after(left, () => stopAll({ status: 'failed', reason: 'expired' }));
      } else if (opened.error !== 'code_in_use') {
        return { status: 'failed', reason: 'relay', detail: opened.error };
      }
    }
    if (slotId === undefined || psk === undefined) {
      return { status: 'failed', reason: 'relay', detail: 'code_in_use' };
    }
    print(`Pairing code: ${formatPairingCode(code)}`);
    print(`QR text:      ${pairingQrText(options.relayHost, agentId!, psk)}`);
    print('Enter the code on the phone within 5 minutes. Waiting for the phone...');

    for (;;) {
      const first = await nextFrom(undefined);
      if (first === undefined) return failure!;
      const status = await api.slotStatus(slotId);
      if (
        !status.ok ||
        status.value.state !== 'joined' ||
        status.value.phoneDeviceId !== first.from
      ) {
        // Not the phone that joined this slot: not an attempt, just noise.
        continue;
      }
      const attempt = await respond(first, psk);
      if (attempt === 'stopped') return failure!;
      if (attempt === 'failed') {
        const failed = await api.failSlot(slotId);
        if (!failed.ok) return { status: 'failed', reason: 'relay', detail: failed.error };
        print(`Pairing handshake failed (${failed.value.failedAttempts} of 3).`);
        if (failed.value.state === 'closed') {
          slotId = undefined;
          return { status: 'failed', reason: 'attempts' };
        }
        continue;
      }
      const fingerprint = await pairingFingerprint(attempt.phoneKey, options.deviceKey.publicKey);
      print(`Phone "${attempt.name}" wants to pair. Fingerprint: ${fingerprint}`);
      const yes = await options.prompt.confirm(
        `Does the phone show ${fingerprint}?`,
        options.signal,
      );
      if (failure !== undefined) return failure;
      if (!yes) return { status: 'declined' };
      const completed = await api.completeSlot(slotId);
      if (!completed.ok) return { status: 'failed', reason: 'relay', detail: completed.error };
      slotId = undefined;
      const peer: Peer = {
        deviceId: completed.value.phoneDeviceId,
        name: attempt.name,
        publicKey: toBase64Url(attempt.phoneKey),
        pairedAt: clock.now(),
      };
      await options.addPeer(peer);
      finished = true;
      return { status: 'paired', peer, fingerprint };
    }
  } finally {
    options.signal.removeEventListener('abort', onAbort);
    expiry?.cancel();
    envelopes.stop();
    if (slotId !== undefined && !finished) await api.cancelSlot(slotId);
    client.stop();
  }

  /** XXpsk0 responder: msg1 in, msg2 (our hello) out, msg3 (the phone's hello) in. */
  async function respond(
    first: Envelope,
    psk: Uint8Array,
  ): Promise<'failed' | 'stopped' | { phoneKey: Uint8Array; name: string }> {
    try {
      const state = await HandshakeState.initialize({
        pattern: XXPSK0,
        initiator: false,
        prologue: pairingPrologue({ userId: options.userId, agentDeviceId: agentId! }),
        random,
        staticKeyPair: options.deviceKey,
        psk,
      });
      await state.readMessage(handshakeBytes(first)!);
      const hello: PairingHello = { name: options.agentName.slice(0, 64) };
      reply(first.from, await state.writeMessage(new TextEncoder().encode(JSON.stringify(hello))));
      const third = await nextFrom(first.from);
      if (third === undefined) return 'stopped';
      const payload = await state.readMessage(handshakeBytes(third)!);
      const phoneHello = PairingHello.parse(JSON.parse(new TextDecoder().decode(payload)));
      return { phoneKey: state.remoteStaticPublicKey!, name: phoneHello.name };
    } catch {
      return 'failed';
    }
  }
}
