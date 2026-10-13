import { z } from 'zod';

import { CanonicalDecision } from './canonical-decision.js';
import { ApprovalRequest } from './domain/approval-request.js';
import { Instruction } from './domain/instruction.js';
import { Machine } from './domain/machine.js';
import { PairedDevice } from './domain/paired-device.js';
import { Question } from './domain/question.js';
import { Repository } from './domain/repository.js';
import { Session } from './domain/session.js';
import { StartSession } from './domain/start-session.js';
import { RequestId, SessionId } from './ids.js';
import { FeedEvent } from './session-feed.js';

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

/** A pending `AskUserQuestion` for the phone (M1-01); `ttlMs` as for `request`. */
export const QuestionMessage = z.strictObject({
  t: z.literal('question'),
  question: Question,
  ttlMs: z.int().nonnegative(),
});
export type QuestionMessage = z.infer<typeof QuestionMessage>;

/**
 * Sent after every handshake (D4) and whenever the agent's session list changes: the
 * machine, its sessions, and the ids of every request still pending, so the phone can
 * drop any request it shows that is gone. `repositories` is the allow-list a new
 * session can start in (M1-04); older agents leave it out. `devices` (the paired phones)
 * and `hooksInstalled` feed the `/machines` screen and its checklist (M1-07).
 */
export const SnapshotMessage = z.strictObject({
  t: z.literal('snapshot'),
  machine: Machine,
  sessions: z.array(Session).max(100),
  pending: z.array(RequestId).max(100),
  repositories: z.array(Repository).max(100).optional(),
  devices: z.array(PairedDevice).max(100).optional(),
  hooksInstalled: z.boolean().optional(),
});
export type SnapshotMessage = z.infer<typeof SnapshotMessage>;

/**
 * A request ended (D25): a phone decided it (`allow`, `deny`, `terminal`, `answer`), or it left
 * the agent some other way (`withdrawn`: answered in the terminal, replaced, shutdown).
 */
export const ResolvedMessage = z.strictObject({
  t: z.literal('resolved'),
  requestId: RequestId,
  outcome: z.enum(['allow', 'deny', 'terminal', 'answer', 'withdrawn']),
});
export type ResolvedMessage = z.infer<typeof ResolvedMessage>;

/** A request reached its deadline and went back to the terminal (D10). */
export const ExpiredMessage = z.strictObject({
  t: z.literal('expired'),
  requestId: RequestId,
});
export type ExpiredMessage = z.infer<typeof ExpiredMessage>;

/**
 * Why the agent refused a decision; the D7 checks in order. `wrong_kind`: the kind does
 * not fit the request (an `answer` for a permission, an `allow` for a question);
 * `invalid_answer`: the answer payload does not fit the pending questions (M1-01).
 * M1-04: `not_allowed` (the repository is not on the allow-list), `start_failed` (the
 * agent CLI refused to start, for example an untrusted folder), `follow_up_unsupported`
 * (the session cannot take a follow-up: interactive, unknown or an old CLI).
 */
export const DecisionRejection = z.enum([
  'no_session',
  'unsupported',
  'unknown_request',
  'already_resolved',
  'wrong_kind',
  'hash_mismatch',
  'expired',
  'too_late',
  'wrong_peer',
  'unverified',
  'invalid_answer',
  'not_allowed',
  'start_failed',
  'follow_up_unsupported',
]);
export type DecisionRejection = z.infer<typeof DecisionRejection>;

/**
 * The agent's answer to one `decision`, `start` or `instruct` message (`cls: reply`,
 * `replyTo` = its envelope). An accepted `start` names the new session when the agent
 * learned its id.
 */
export const DecisionResultMessage = z.union([
  z.strictObject({
    t: z.literal('decision_result'),
    requestId: RequestId,
    result: z.literal('accepted'),
    sessionId: SessionId.optional(),
  }),
  z.strictObject({
    t: z.literal('decision_result'),
    requestId: RequestId,
    result: z.literal('rejected'),
    reason: DecisionRejection,
  }),
]);
export type DecisionResultMessage = z.infer<typeof DecisionResultMessage>;

const Count = z.int().nonnegative();

/**
 * One project's lifetime counters on the agent's computer (M2-06), keyed by the folder
 * name. `activeMs` adds up turns, from the prompt to the agent's stop; `lastActiveAt`
 * is the agent's epoch ms of the latest counted activity, `null` before any.
 */
export const ProjectHistory = z.strictObject({
  project: z.string().min(1).max(128),
  sessions: Count,
  toolCalls: Count,
  approvals: Count,
  denials: Count,
  activeMs: Count,
  lastActiveAt: Count.nullable(),
});
export type ProjectHistory = z.infer<typeof ProjectHistory>;

/** How many projects one `history` message lists; the most recently active first. */
export const MAX_HISTORY_PROJECTS = 200;

/**
 * The agent's per-project history (M2-06): sent after every snapshot and again when a
 * turn ends. It replaces whatever the phone showed for this computer.
 */
export const HistoryMessage = z.strictObject({
  t: z.literal('history'),
  projects: z.array(ProjectHistory).max(MAX_HISTORY_PROJECTS),
});
export type HistoryMessage = z.infer<typeof HistoryMessage>;

/**
 * One live feed event for a session (M1-05, `cls: event`). `seq` counts the session's
 * events: the phone applies it with `applyFeedEvent` only when `seq` is past the
 * snapshot's `feedSeq` (a snapshot built after the event already includes it). An event
 * for a session the phone does not know waits for the next snapshot.
 */
export const EventMessage = z.strictObject({
  t: z.literal('event'),
  sessionId: SessionId,
  seq: z.int().positive(),
  event: FeedEvent,
});
export type EventMessage = z.infer<typeof EventMessage>;

/** Lines of one diff the agent sends and the phone renders (M2-02, 05 W11). */
export const MAX_DIFF_LINES = 2000;
/** Characters of one diff's patch text: it must fit one frame with its message. */
export const MAX_DIFF_LENGTH = 60_000;

const DiffFile = z.string().min(1).max(4096);

/**
 * The phone asks for one changed file's diff (M2-02, `cls: command`, no `decisionHash`):
 * diff bodies are fetched on demand, never pushed (D21). `requestId` is the phone's own.
 */
export const DiffRequestMessage = z.strictObject({
  t: z.literal('diff_request'),
  requestId: RequestId,
  sessionId: SessionId,
  file: DiffFile,
});
export type DiffRequestMessage = z.infer<typeof DiffRequestMessage>;

/**
 * The agent's answer to a `diff_request` (`cls: reply`): the file's unified diff hunks
 * (`@@ -a,b +c,d @@` and their lines, no file header), oldest edit first. `patch` is
 * `null` when the agent does not keep a diff for the file (restarted, evicted, unknown).
 * `truncated`: older hunks or lines were left out to fit the caps.
 */
export const DiffMessage = z.strictObject({
  t: z.literal('diff'),
  requestId: RequestId,
  sessionId: SessionId,
  file: DiffFile,
  patch: z.string().max(MAX_DIFF_LENGTH).nullable(),
  truncated: z.boolean(),
});
export type DiffMessage = z.infer<typeof DiffMessage>;

/** Everything the agent sends to a phone inside a session. */
export const AgentMessage = z.union([
  RequestMessage,
  QuestionMessage,
  SnapshotMessage,
  ResolvedMessage,
  ExpiredMessage,
  DecisionResultMessage,
  HistoryMessage,
  EventMessage,
  DiffMessage,
]);
export type AgentMessage = z.infer<typeof AgentMessage>;

/** Unpadded base64url (RFC 4648 §5) of at most `max` characters. */
const base64Url = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/);

/**
 * The WebAuthn assertion over a decision (D7 phase 2, M2-03): the fields of the
 * `AuthenticationResponseJSON` the agent needs to verify it, all unpadded base64url. It
 * travels inside the encrypted message, so the relay never sees it; the agent checks the
 * ES256 signature over `authenticatorData || SHA-256(clientDataJSON)` with the passkey
 * key the phone handed over at pairing.
 */
export const DecisionAssertion = z.strictObject({
  credentialId: base64Url(1366),
  authenticatorData: base64Url(1366),
  clientDataJSON: base64Url(2732),
  signature: base64Url(128),
});
export type DecisionAssertion = z.infer<typeof DecisionAssertion>;

/**
 * The phone's decision (`cls: command`). The envelope carries `decisionHash` for every
 * kind that needs a passkey assertion; the agent re-computes it from `decision` (D7).
 * `assertion` is the passkey assertion over the decision (M2-03); the agent requires it
 * from a phone that handed over its passkey keys at pairing.
 */
export const DecisionMessage = z.strictObject({
  t: z.literal('decision'),
  decision: CanonicalDecision,
  assertion: DecisionAssertion.optional(),
});
export type DecisionMessage = z.infer<typeof DecisionMessage>;

/**
 * Start a session (M1-04, `cls: command`). `decision.kind` is `start`, its `payload` the
 * repository id and its `request_hash` the `requestHash({ prompt, cwd, permissionMode })`
 * of the prompt, the repository's path and the picked mode (left out when none was
 * picked, M2-09); the phone picks a fresh `request_id`.
 */
export const StartMessage = z.strictObject({
  t: z.literal('start'),
  start: StartSession,
  decision: CanonicalDecision,
  assertion: DecisionAssertion.optional(),
});
export type StartMessage = z.infer<typeof StartMessage>;

/**
 * A follow-up prompt for a running session (M1-04, `cls: command`). `decision.kind` is
 * `instruct`, its `payload` the text and its `request_hash` the
 * `requestHash({ prompt, sessionId })`; the phone picks a fresh `request_id`.
 */
export const InstructMessage = z.strictObject({
  t: z.literal('instruct'),
  instruction: Instruction,
  decision: CanonicalDecision,
  assertion: DecisionAssertion.optional(),
});
export type InstructMessage = z.infer<typeof InstructMessage>;

/** Everything a phone sends to the agent inside a session. */
export const PhoneMessage = z.union([
  DecisionMessage,
  StartMessage,
  InstructMessage,
  DiffRequestMessage,
]);
export type PhoneMessage = z.infer<typeof PhoneMessage>;

/** The device name each side tells the other inside the XXpsk0 pairing handshake (D6). */
export const PairingHello = z.strictObject({
  name: z.string().trim().min(1).max(64),
});
export type PairingHello = z.infer<typeof PairingHello>;

/**
 * A passkey of the phone's account as the agent needs it to verify assertions itself
 * (D7 phase 2, M2-03): the credential id, the public key as SubjectPublicKeyInfo (what
 * `getPublicKey()` returns at registration; ES256 only, D7) and the relying party id the
 * credential is scoped to, all as the phone saw them at registration.
 */
export const PairedPasskey = z.strictObject({
  id: base64Url(1366),
  publicKey: base64Url(512),
  rpId: z.string().min(1).max(253),
});
export type PairedPasskey = z.infer<typeof PairedPasskey>;

/**
 * The phone's hello in the last pairing message (msg3): its name and the passkeys it
 * knows the keys of. The XXpsk0 handshake authenticates it, so the agent trusts these
 * keys as much as the pairing itself; the relay never sees them.
 */
export const PhonePairingHello = PairingHello.extend({
  passkeys: z.array(PairedPasskey).max(16).optional(),
});
export type PhonePairingHello = z.infer<typeof PhonePairingHello>;

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
