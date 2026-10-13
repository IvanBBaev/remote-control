import type { AssertDecisionResult } from '../auth/assert-decision.js';
import type { CommandView, RequestView } from '../realtime/realtime-store.js';

/** Taps this soon after the card appears are ignored: no accidental Allow (05 Rec-2). */
export const TAP_GUARD_MS = 600;

/** `m:ss` for a countdown. */
export function countdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
}

export type Failure = Extract<AssertDecisionResult, { ok: false }>['failure'];

export function failureText(failure: Failure): string {
  if (failure === 'cancelled') return 'Face ID was cancelled. Nothing was sent.';
  if (failure === 'offline') return 'You are offline. Nothing was sent.';
  if (failure === 'rate_limited') return 'Too many attempts. Wait a minute and try again.';
  return 'Could not confirm with your passkey. Nothing was sent.';
}

/** A request handed back to the terminal ("Reply in terminal", D10). */
export const RELEASED_TEXT = 'Handed back to the terminal. Answer it on your computer.';

const OUTCOMES: Record<NonNullable<RequestView['outcome']>, string> = {
  allow: 'Allowed.',
  deny: 'Denied.',
  answer: 'Answered.',
  terminal: RELEASED_TEXT,
  withdrawn: 'The agent no longer needs this answer.',
};

const REJECTIONS: Partial<Record<string, string>> = {
  already_resolved: 'Already answered elsewhere.',
  expired: 'Too late: the request had expired.',
  too_late: 'Too late: the request had expired.',
  unknown_request: 'The computer no longer has this request.',
  invalid_answer: 'Your computer could not use that answer. Answer it in the terminal.',
};

/** The final state of a request that is no longer pending, or a refused decision. */
export function closedText(view: RequestView): string | undefined {
  if (view.result?.result === 'rejected') {
    return REJECTIONS[view.result.reason] ?? 'Your computer refused the decision.';
  }
  if (view.relayError !== undefined) return 'The relay refused the decision. Try again.';
  if (view.status === 'expired') return 'Expired. The terminal is asking again.';
  if (view.status === 'resolved' && view.outcome !== undefined) return OUTCOMES[view.outcome];
  return undefined;
}

const COMMAND_REJECTIONS: Partial<Record<string, string>> = {
  not_allowed: "That folder is not on your computer's allow-list. Nothing was started.",
  start_failed: 'The computer did not start the session. Try again.',
  follow_up_unsupported:
    'This session cannot take instructions from the phone. Continue it in the terminal.',
  unsupported: "Your computer's remotectl cannot do this yet. Update it and try again.",
  expired: 'Too late: it took too long to reach your computer. Try again.',
  too_late: 'Too late: it took too long to reach your computer. Try again.',
  no_session: 'Your computer lost the connection. Try again.',
};

/** Where a sent start or instruction stands (M1-04); `undefined` while it is on its way. */
export function commandText(view: CommandView): string | undefined {
  if (view.result?.result === 'rejected') {
    return COMMAND_REJECTIONS[view.result.reason] ?? 'Your computer refused it.';
  }
  if (view.result?.result === 'accepted') {
    return view.kind === 'start' ? 'Session started.' : 'Sent to the session.';
  }
  if (view.relayError === 'expired') return 'Not delivered in time. Nothing was sent.';
  if (view.relayError !== undefined) return 'The relay refused it. Try again.';
  return undefined;
}
