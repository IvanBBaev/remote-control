import { describe, expect, it } from 'vitest';

import { CanonicalDecision, DECISION_TTL_SECONDS, DecisionKind } from './canonical-decision.js';
import { requiresAssertion } from './requires-assertion.js';

const base = {
  v: 1,
  request_id: '0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b',
  request_hash: '4196590ec41b976c1c2f586f398945a01bf0e4c11b18bab7809211a4c8025bcf',
  issued_at: 1_791_763_200,
  expires_at: 1_791_763_200 + DECISION_TTL_SECONDS,
  phone_device_id: '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f',
  agent_device_id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
};

const WITHOUT_PAYLOAD = ['allow', 'deny', 'terminal'];

describe('CanonicalDecision', () => {
  it('has a 300 second TTL (D7)', () => {
    expect(DECISION_TTL_SECONDS).toBe(300);
  });

  it.each(DecisionKind.options.filter((kind) => kind !== 'always'))(
    '%s carries a payload exactly when it needs one',
    (kind) => {
      const needsNull = WITHOUT_PAYLOAD.includes(kind);
      const ok = CanonicalDecision.safeParse({ ...base, kind, payload: needsNull ? null : 'x' });
      const wrong = CanonicalDecision.safeParse({ ...base, kind, payload: needsNull ? 'x' : null });
      expect(ok.success).toBe(true);
      expect(wrong.success).toBe(false);
      expect(wrong.error?.issues[0]?.path).toEqual(['payload']);
    },
  );

  it.each([null, 'localSettings', 'projectSettings'])('always may carry %s (M2-07)', (payload) => {
    expect(CanonicalDecision.safeParse({ ...base, kind: 'always', payload }).success).toBe(true);
  });

  it.each(['session', 'userSettings', 'x', ''])('always refuses the payload %j', (payload) => {
    const result = CanonicalDecision.safeParse({ ...base, kind: 'always', payload });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['payload']);
  });

  it.each([-1, 1, 299, 301, 600])('refuses expires_at = issued_at + %i', (delta) => {
    const result = CanonicalDecision.safeParse({
      ...base,
      kind: 'deny',
      payload: null,
      expires_at: base.issued_at + delta,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['expires_at']);
  });
});

describe('requiresAssertion', () => {
  it.each([
    ['allow', true],
    ['always', true],
    ['deny', false],
    ['terminal', false],
    ['answer', true],
    ['instruct', true],
    ['start', true],
  ] as const)('%s -> %s', (kind, expected) => {
    expect(requiresAssertion(kind)).toBe(expected);
  });

  it('is defined for every decision kind', () => {
    expect(DecisionKind.options).toHaveLength(7);
  });
});
