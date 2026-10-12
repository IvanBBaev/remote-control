import { REQUEST_TRANSITIONS } from './request-lifecycle.js';
import type { RequestEvent, RequestState } from './request-lifecycle.js';

/** Outcome of applying an event; an illegal event leaves the request where it was. */
export type RequestTransition =
  | { readonly ok: true; readonly from: RequestState; readonly to: RequestState }
  | { readonly ok: false; readonly from: RequestState; readonly event: RequestEvent };

/**
 * Applies `event` to a request in state `from` using `REQUEST_TRANSITIONS`. A second
 * decision, or a decision after release or expiry, is illegal: decide-once (02 P7), and
 * a late decision is undeliverable rather than queued (I2, 01 W5).
 */
export function transitionRequest(from: RequestState, event: RequestEvent): RequestTransition {
  const row: Partial<Record<RequestEvent, RequestState>> = REQUEST_TRANSITIONS[from];
  const to = row[event];
  return to === undefined ? { ok: false, from, event } : { ok: true, from, to };
}
