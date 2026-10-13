import type { CanonicalDecision, DecisionRejection } from '@remote-control/protocol';

/** What a `start` or `instruct` message names, as far as the checks need it. */
export type CommandTarget =
  | { readonly ok: true; readonly requestHash: string }
  | { readonly ok: false; readonly reason: 'not_allowed' | 'follow_up_unsupported' };

export interface CommandCheckInput {
  /** The sender has a completed KK session with this agent. */
  readonly session: boolean;
  /** The message type: `start` or `instruct`. */
  readonly message: 'start' | 'instruct';
  /** This agent starts sessions / takes follow-ups (capability and launcher). */
  readonly supported: boolean;
  readonly decision: CanonicalDecision;
  /** The signed payload equals the message's repository id or instruction text. */
  readonly payloadMatches: boolean;
  /** For `start`: the message names this machine. Always `true` for `instruct`. */
  readonly machineMatches: boolean;
  /** The decision's `request_id` was already accepted and has not expired. */
  readonly used: boolean;
  readonly from: string;
  /** A passkey with UV signed the decision (see `DecisionCheckInput.verified`). */
  readonly verified: boolean;
  readonly agentDeviceId: string;
  readonly target: CommandTarget;
  /** Unix epoch milliseconds. */
  readonly now: number;
}

export type CommandCheckResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: DecisionRejection };

/**
 * The D7 checks for a phone command that starts a session or sends a follow-up (M1-04),
 * as a pure function, in order: KK session; the decision kind matches the message and
 * the agent supports it; the request id not used before (decide-once); the signed payload
 * names what the message names; decision expiry; the peers (and for `start` the machine);
 * a verified passkey assertion (both kinds need one); the target (an allow-listed
 * repository, a session that takes follow-ups); and the request hash over the prompt and
 * its folder or session. The first failing check is the reason.
 */
export function checkCommand(input: CommandCheckInput): CommandCheckResult {
  const { decision } = input;
  if (!input.session) return { ok: false, reason: 'no_session' };
  if (decision.kind !== input.message || !input.supported) {
    return { ok: false, reason: 'unsupported' };
  }
  if (input.used) return { ok: false, reason: 'already_resolved' };
  if (!input.payloadMatches) return { ok: false, reason: 'wrong_kind' };
  if (input.now >= decision.expires_at * 1000) return { ok: false, reason: 'expired' };
  if (
    decision.phone_device_id !== input.from ||
    decision.agent_device_id !== input.agentDeviceId ||
    !input.machineMatches
  ) {
    return { ok: false, reason: 'wrong_peer' };
  }
  if (!input.verified) return { ok: false, reason: 'unverified' };
  if (!input.target.ok) return { ok: false, reason: input.target.reason };
  if (decision.request_hash !== input.target.requestHash) {
    return { ok: false, reason: 'hash_mismatch' };
  }
  return { ok: true };
}
