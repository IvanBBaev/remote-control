import { describe, expect, it } from 'vitest';

import { REQUEST_TRANSITIONS, RequestEvent, RequestState } from './request-lifecycle.js';
import { transitionRequest } from './transition-request.js';

const LEGAL: Readonly<Record<string, string>> = {
  'pending:decide': 'decided',
  'pending:release': 'released',
  'pending:expire': 'expired',
  'pending:deliveryFailed': 'undeliverable',
  'pending:supersede': 'superseded',
};

const PAIRS = RequestState.options.flatMap((from) =>
  RequestEvent.options.map((event) => [from, event] as const),
);

describe('request lifecycle', () => {
  it('covers all 6 states and 5 events', () => {
    expect(RequestState.options).toEqual([
      'pending',
      'decided',
      'released',
      'expired',
      'undeliverable',
      'superseded',
    ]);
    expect(RequestEvent.options).toEqual([
      'decide',
      'release',
      'expire',
      'deliveryFailed',
      'supersede',
    ]);
    expect(PAIRS).toHaveLength(30);
    expect(Object.keys(REQUEST_TRANSITIONS).sort()).toEqual([...RequestState.options].sort());
  });

  it.each(PAIRS)('%s --%s--> follows the transition table', (from, event) => {
    const to = LEGAL[`${from}:${event}`];
    expect(transitionRequest(from, event)).toEqual(
      to === undefined ? { ok: false, from, event } : { ok: true, from, to },
    );
  });

  it('every state other than pending is terminal', () => {
    for (const state of RequestState.options.filter((s) => s !== 'pending')) {
      expect(REQUEST_TRANSITIONS[state]).toEqual({});
    }
  });

  it('refuses a second decision (D25: the first decision wins)', () => {
    expect(transitionRequest('decided', 'decide').ok).toBe(false);
  });

  it('refuses a decision after expiry (01 W5: it is undeliverable)', () => {
    expect(transitionRequest('expired', 'decide')).toEqual({
      ok: false,
      from: 'expired',
      event: 'decide',
    });
  });
});
