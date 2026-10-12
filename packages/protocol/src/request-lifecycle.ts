import { z } from 'zod';

/** Where a request is in its life (01 W5). Every state but `pending` is terminal. */
export const RequestState = z.enum([
  'pending',
  'decided',
  'released',
  'expired',
  'undeliverable',
  'superseded',
]);
export type RequestState = z.infer<typeof RequestState>;

/**
 * What can happen to a request:
 * - `decide` — a phone's decision was accepted (first one wins, D25);
 * - `release` — handed back to the terminal, by the phone or at the hold deadline (D10);
 * - `expire` — no decision before the deadline with `onExpire: deny` (D10);
 * - `deliveryFailed` — the answer could not reach the hook (the hook is gone);
 * - `supersede` — Claude Code moved on without us (answered in the terminal, session ended).
 */
export const RequestEvent = z.enum(['decide', 'release', 'expire', 'deliveryFailed', 'supersede']);
export type RequestEvent = z.infer<typeof RequestEvent>;

/** The complete transition table; an event missing from a row is illegal in that state. */
export const REQUEST_TRANSITIONS = {
  pending: {
    decide: 'decided',
    release: 'released',
    expire: 'expired',
    deliveryFailed: 'undeliverable',
    supersede: 'superseded',
  },
  decided: {},
  released: {},
  expired: {},
  undeliverable: {},
  superseded: {},
} as const satisfies Record<RequestState, Partial<Record<RequestEvent, RequestState>>>;
