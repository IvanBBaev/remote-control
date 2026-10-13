import type { CanonicalDecision } from '@remote-control/protocol';
import { describe, expect, it } from 'vitest';

import { M0_DECISION_KINDS, checkDecision, type DecisionCheckInput } from './decision-check.js';

const PHONE = '0190a1b2-0000-7000-8000-0000000000a1';
const AGENT = '0190a1b2-0000-7000-8000-0000000000b2';
const NOW = 1_760_000_000_000;
const HASH = 'a'.repeat(64);
const DECISION_HASH = 'd'.repeat(64);

const decision: CanonicalDecision = {
  v: 1,
  kind: 'allow',
  request_id: '00000000-0000-4000-8000-000000000001',
  request_hash: HASH,
  payload: null,
  issued_at: NOW / 1000,
  expires_at: NOW / 1000 + 300,
  phone_device_id: PHONE,
  agent_device_id: AGENT,
};

function input(overrides: Partial<DecisionCheckInput> = {}): DecisionCheckInput {
  return {
    session: true,
    decision,
    from: PHONE,
    envelopeDecisionHash: DECISION_HASH,
    computedDecisionHash: DECISION_HASH,
    request: { requestHash: HASH, deadline: NOW + 60_000 },
    ended: false,
    agentDeviceId: AGENT,
    supportedKinds: M0_DECISION_KINDS,
    now: NOW,
    ...overrides,
  };
}

describe('checkDecision', () => {
  it('accepts a decision that passes every check', () => {
    expect(checkDecision(input())).toEqual({ ok: true });
    // Deny and terminal need no assertion: the relay forwards them without a hash.
    for (const kind of ['deny', 'terminal'] as const) {
      expect(
        checkDecision(input({ decision: { ...decision, kind }, envelopeDecisionHash: undefined })),
      ).toEqual({ ok: true });
    }
  });

  it.each<[string, Partial<DecisionCheckInput>]>([
    ['no_session', { session: false }],
    ['unsupported', { decision: { ...decision, kind: 'always' } }],
    ['unknown_request', { request: undefined }],
    ['already_resolved', { request: undefined, ended: true }],
    ['hash_mismatch', { decision: { ...decision, request_hash: 'b'.repeat(64) } }],
    ['expired', { now: NOW + 300_000, request: { requestHash: HASH, deadline: NOW + 600_000 } }],
    ['too_late', { now: NOW + 60_000 }],
    ['wrong_peer', { from: AGENT }],
    ['wrong_peer', { agentDeviceId: PHONE }],
    ['unverified', { envelopeDecisionHash: undefined }],
    ['unverified', { envelopeDecisionHash: 'e'.repeat(64) }],
  ])('rejects with %s', (reason, overrides) => {
    expect(checkDecision(input(overrides))).toEqual({ ok: false, reason });
  });

  it('reports the first failing check (D7 order)', () => {
    expect(
      checkDecision(
        input({
          session: false,
          request: undefined,
          from: AGENT,
          envelopeDecisionHash: undefined,
        }),
      ),
    ).toEqual({ ok: false, reason: 'no_session' });
    expect(
      checkDecision(
        input({ decision: { ...decision, request_hash: 'b'.repeat(64) }, now: NOW + 600_000 }),
      ),
    ).toEqual({ ok: false, reason: 'hash_mismatch' });
    expect(checkDecision(input({ now: NOW + 300_000 }))).toEqual({
      ok: false,
      reason: 'expired',
    });
  });
});
