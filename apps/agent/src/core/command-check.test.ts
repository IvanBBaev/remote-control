import type { CanonicalDecision } from '@remote-control/protocol';
import { describe, expect, it } from 'vitest';

import { checkCommand, type CommandCheckInput } from './command-check.js';

const PHONE = '0190a1b2-0000-7000-8000-0000000000a1';
const AGENT = '0190a1b2-0000-7000-8000-0000000000b2';
const NOW = 1_760_000_000_000;
const HASH = 'a'.repeat(64);

const decision: CanonicalDecision = {
  v: 1,
  kind: 'start',
  request_id: '00000000-0000-4000-8000-000000000001',
  request_hash: HASH,
  payload: 'f'.repeat(32),
  issued_at: NOW / 1000,
  expires_at: NOW / 1000 + 300,
  phone_device_id: PHONE,
  agent_device_id: AGENT,
};

function input(overrides: Partial<CommandCheckInput> = {}): CommandCheckInput {
  return {
    session: true,
    message: 'start',
    supported: true,
    decision,
    payloadMatches: true,
    machineMatches: true,
    used: false,
    from: PHONE,
    verified: true,
    agentDeviceId: AGENT,
    target: { ok: true, requestHash: HASH },
    now: NOW,
    ...overrides,
  };
}

describe('checkCommand', () => {
  it('accepts a start and an instruct that pass every check', () => {
    expect(checkCommand(input())).toEqual({ ok: true });
    expect(
      checkCommand(
        input({ message: 'instruct', decision: { ...decision, kind: 'instruct', payload: 'go' } }),
      ),
    ).toEqual({ ok: true });
  });

  it.each<[string, Partial<CommandCheckInput>]>([
    ['no_session', { session: false }],
    ['unsupported', { supported: false }],
    ['unsupported', { message: 'instruct' }],
    ['unsupported', { decision: { ...decision, kind: 'allow', payload: null } }],
    ['already_resolved', { used: true }],
    ['wrong_kind', { payloadMatches: false }],
    ['expired', { now: NOW + 300_000 }],
    ['wrong_peer', { from: AGENT }],
    ['wrong_peer', { agentDeviceId: PHONE }],
    ['wrong_peer', { machineMatches: false }],
    ['unverified', { verified: false }],
    ['not_allowed', { target: { ok: false, reason: 'not_allowed' } }],
    ['follow_up_unsupported', { target: { ok: false, reason: 'follow_up_unsupported' } }],
    ['hash_mismatch', { target: { ok: true, requestHash: 'b'.repeat(64) } }],
  ])('rejects with %s', (reason, overrides) => {
    expect(checkCommand(input(overrides))).toEqual({ ok: false, reason });
  });

  it('checks in order: the first failing check is the reason', () => {
    expect(checkCommand(input({ used: true, payloadMatches: false, now: NOW + 300_000 }))).toEqual({
      ok: false,
      reason: 'already_resolved',
    });
    expect(
      checkCommand(input({ verified: false, target: { ok: false, reason: 'not_allowed' } })),
    ).toEqual({ ok: false, reason: 'unverified' });
  });
});
