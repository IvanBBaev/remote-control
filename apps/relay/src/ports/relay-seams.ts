import type { Envelope } from '@remote-control/protocol';

import type { TrackedDelivery } from '../core/ack-tracker.js';
import type { DeviceIdentity } from './device-directory.js';

/**
 * Admission of `cls: command` envelopes (M0-11): the relay forwards a command only with a
 * verified `decision_hash`. Until M0-11 replaces it, {@link admitAllCommands} lets every
 * command through. It sees routing headers only, never the payload (I3).
 */
export interface CommandGate {
  admit(envelope: Envelope, sender: DeviceIdentity): boolean;
}

export const admitAllCommands: CommandGate = { admit: () => true };

/** An envelope addressed to a device of the same user that has no live socket. */
export interface UndeliveredEnvelope {
  readonly envelopeId: string;
  readonly userId: string;
  readonly from: string;
  readonly to: string;
  readonly cls: Envelope['cls'];
  readonly expiresAt: number | null;
}

/**
 * Where Web Push hooks in (M0-12, D4): a `cls: request` for a phone that is offline, or
 * that stayed unacked for 3 s. The relay keeps no copy of the envelope (no outbox); the
 * sender re-sends after the phone reconnects. The default ignores both.
 */
export interface PendingRequestSink {
  undelivered(envelope: UndeliveredEnvelope): void;
  unacked(delivery: TrackedDelivery): void;
}

export const ignorePendingRequests: PendingRequestSink = {
  undelivered: () => undefined,
  unacked: () => undefined,
};
