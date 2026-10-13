import type { AssertDecisionResult } from '../auth/assert-decision.js';
import type { RequestView } from '../realtime/realtime-store.js';

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

const OUTCOMES: Record<NonNullable<RequestView['outcome']>, string> = {
  allow: 'Allowed.',
  deny: 'Denied.',
  answer: 'Answered.',
  terminal: 'Answered in the terminal.',
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
