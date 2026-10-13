import { z } from 'zod';

import { CanonicalDecision } from './canonical-decision.js';
import { ApprovalRequest } from './domain/approval-request.js';
import { Machine } from './domain/machine.js';
import { Session } from './domain/session.js';
import { RequestId } from './ids.js';

// End-to-end messages (M0-16): the plaintext inside an envelope's `payload`, after the
// Noise transport session decrypts it. The relay never sees any of this (I3).

/**
 * A pending request for the phone. `ttlMs` is the time left until the agent's deadline
 * at send time, so a phone with a skewed clock still counts down correctly (D4, D10).
 */
export const RequestMessage = z.strictObject({
  t: z.literal('request'),
  request: ApprovalRequest,
  ttlMs: z.int().nonnegative(),
});
export type RequestMessage = z.infer<typeof RequestMessage>;

/**
 * Sent after every handshake (D4): the machine, its sessions, and the ids of every
 * request still pending, so the phone can drop any request it shows that is gone.
 */
export const SnapshotMessage = z.strictObject({
  t: z.literal('snapshot'),
  machine: Machine,
  sessions: z.array(Session).max(100),
  pending: z.array(RequestId).max(100),
});
export type SnapshotMessage = z.infer<typeof SnapshotMessage>;

/**
 * A request ended (D25): a phone decided it (`allow`, `deny`, `terminal`), or it left
 * the agent some other way (`withdrawn`: answered in the terminal, replaced, shutdown).
 */
export const ResolvedMessage = z.strictObject({
  t: z.literal('resolved'),
  requestId: RequestId,
  outcome: z.enum(['allow', 'deny', 'terminal', 'withdrawn']),
});
export type ResolvedMessage = z.infer<typeof ResolvedMessage>;

/** A request reached its deadline and went back to the terminal (D10). */
export const ExpiredMessage = z.strictObject({
  t: z.literal('expired'),
  requestId: RequestId,
});
export type ExpiredMessage = z.infer<typeof ExpiredMessage>;

/** Why the agent refused a decision; the D7 checks in order, then the M0 limits. */
export const DecisionRejection = z.enum([
  'no_session',
  'unsupported',
  'unknown_request',
  'already_resolved',
  'hash_mismatch',
  'expired',
  'too_late',
  'wrong_peer',
  'unverified',
]);
export type DecisionRejection = z.infer<typeof DecisionRejection>;

/** The agent's answer to one `decision` message (`cls: reply`, `replyTo` = its envelope). */
export const DecisionResultMessage = z.union([
  z.strictObject({
    t: z.literal('decision_result'),
    requestId: RequestId,
    result: z.literal('accepted'),
  }),
  z.strictObject({
    t: z.literal('decision_result'),
    requestId: RequestId,
    result: z.literal('rejected'),
    reason: DecisionRejection,
  }),
]);
export type DecisionResultMessage = z.infer<typeof DecisionResultMessage>;

/** Everything the agent sends to a phone inside a session. */
export const AgentMessage = z.union([
  RequestMessage,
  SnapshotMessage,
  ResolvedMessage,
  ExpiredMessage,
  DecisionResultMessage,
]);
export type AgentMessage = z.infer<typeof AgentMessage>;

/**
 * The phone's decision (`cls: command`). The envelope carries `decisionHash` for every
 * kind that needs a passkey assertion; the agent re-computes it from `decision` (D7).
 */
export const DecisionMessage = z.strictObject({
  t: z.literal('decision'),
  decision: CanonicalDecision,
});
export type DecisionMessage = z.infer<typeof DecisionMessage>;

/** Everything a phone sends to the agent inside a session. */
export const PhoneMessage = DecisionMessage;
export type PhoneMessage = z.infer<typeof PhoneMessage>;

/** The device name each side tells the other inside the XXpsk0 pairing handshake (D6). */
export const PairingHello = z.strictObject({
  name: z.string().trim().min(1).max(64),
});
export type PairingHello = z.infer<typeof PairingHello>;

/**
 * The first byte of a `cls: control` payload: which handshake message it carries. The
 * rest is the raw Noise handshake message, which Noise itself protects.
 */
export const HANDSHAKE_TAG = Object.freeze({
  /** Noise KK, phone ↔ paired agent (D3). */
  kk: 0x01,
  /** Noise XXpsk0, pairing (D6). */
  pairing: 0x02,
});
