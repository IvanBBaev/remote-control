import {
  requiresAssertion,
  type CanonicalDecision,
  type DecisionKind,
  type DecisionRejection,
} from '@remote-control/protocol';

/** The decision kinds the agent can apply in M0; the rest are `unsupported` (M1-01..04). */
export const M0_DECISION_KINDS: ReadonlySet<DecisionKind> = new Set(['allow', 'deny', 'terminal']);

/** The pending request a decision names, as far as the checks need it. */
export interface CheckedRequest {
  /** Hex SHA-256 the agent computed when the hook fired (D7). */
  readonly requestHash: string;
  /** Unix epoch ms: the store's deadline, already `T − 10 s` (D10). */
  readonly deadline: number;
}

export interface DecisionCheckInput {
  /** The sender has a completed KK session with this agent. */
  readonly session: boolean;
  /** The decision, already parsed as a `CanonicalDecision`. */
  readonly decision: CanonicalDecision;
  /** The envelope's `from`: the phone that sent the decision. */
  readonly from: string;
  /** The envelope's `decisionHash`, which the relay forwards only once verified (M0-11). */
  readonly envelopeDecisionHash: string | undefined;
  /** `decisionHash(decision)`, recomputed by the agent. */
  readonly computedDecisionHash: string;
  /** The pending request with the decision's `request_id`, if any. */
  readonly request: CheckedRequest | undefined;
  /** The id is remembered as ended (decided, deadline, released). */
  readonly ended: boolean;
  readonly agentDeviceId: string;
  readonly supportedKinds: ReadonlySet<DecisionKind>;
  /** Unix epoch milliseconds. */
  readonly now: number;
}

export type DecisionCheckResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: DecisionRejection };

/**
 * The D7 checks, in order, as a pure function: KK session; supported kind; pending and
 * unresolved; request hash; decision expiry; the request's deadline (`T − 10 s`); the
 * peer named in the decision; and, for every kind that needs a passkey, the relay's
 * verification (in M0: the envelope carries `decisionHash`, which the relay forwards
 * only after a verified assertion over it, and it equals the recomputed hash). The
 * first failing check is the reason.
 */
export function checkDecision(input: DecisionCheckInput): DecisionCheckResult {
  const { decision, request } = input;
  if (!input.session) return { ok: false, reason: 'no_session' };
  if (!input.supportedKinds.has(decision.kind)) return { ok: false, reason: 'unsupported' };
  if (request === undefined) {
    return { ok: false, reason: input.ended ? 'already_resolved' : 'unknown_request' };
  }
  if (decision.request_hash !== request.requestHash) return { ok: false, reason: 'hash_mismatch' };
  if (input.now >= decision.expires_at * 1000) return { ok: false, reason: 'expired' };
  if (input.now >= request.deadline) return { ok: false, reason: 'too_late' };
  if (decision.phone_device_id !== input.from || decision.agent_device_id !== input.agentDeviceId) {
    return { ok: false, reason: 'wrong_peer' };
  }
  if (
    requiresAssertion(decision.kind) &&
    input.envelopeDecisionHash !== input.computedDecisionHash
  ) {
    return { ok: false, reason: 'unverified' };
  }
  return { ok: true };
}
