import type { Envelope } from '@remote-control/protocol';

import type { TrackedDelivery } from '../core/ack-tracker.js';
import type { DeviceIdentity } from './device-directory.js';

/**
 * Admission of `cls: command` envelopes (D7): the relay forwards a command that names a
 * `decisionHash` only when the sender verified it (`core/decision-verifier.ts`); a refused
 * command is answered with `error: unverified`. {@link admitAllCommands} is the default for
 * tests that do not exercise the gate. It sees routing headers only, never the payload (I3).
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
  /** The sealed push summary (D5), copied verbatim into the push; never logged or stored. */
  readonly pushBlob?: string;
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

/**
 * Where the router and the push notifier write audit rows (M1-13, 03 W12). Calls are
 * fire-and-forget so the routing path never waits for the database; the production
 * sink is `core/audit-recorder.ts`. Arguments are routing metadata only (I3).
 */
export interface AuditSink {
  /** A `cls: command` carrying `decisionHash` (hex) reached the recipient's socket. */
  decisionForwarded(sender: DeviceIdentity, decisionHash: string): void;
  /** At least one push service accepted a push for this phone. */
  pushSent(userId: string, phoneDeviceId: string): void;
}

export const ignoreAudit: AuditSink = {
  decisionForwarded: () => undefined,
  pushSent: () => undefined,
};
