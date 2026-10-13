import { describe, expect, it } from 'vitest';

import { DECISION_TTL_SECONDS } from './canonical-decision.js';
import {
  AgentMessage,
  DecisionRejection,
  HANDSHAKE_TAG,
  PairingHello,
  PhoneMessage,
} from './messages.js';

const REQUEST_ID = '0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const MACHINE_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

const request = {
  id: REQUEST_ID,
  sessionId: 'sess-1',
  requestHash: '4196590ec41b976c1c2f586f398945a01bf0e4c11b18bab7809211a4c8025bcf',
  toolLabel: 'Run a command',
  toolName: 'Bash',
  content: 'ls',
  truncated: false,
  suggestions: [],
  expiresAt: 1_791_764_990_000,
  alwaysSupported: false,
};

const machine = {
  id: MACHINE_ID,
  name: 'mac',
  platform: 'darwin',
  agentVersion: '0.1.0',
  agents: [],
};

const session = {
  id: 'sess-1',
  machineId: MACHINE_ID,
  repositoryId: null,
  agent: 'claude-code',
  state: 'waiting',
  statusText: 'Waiting for approval',
  lastPrompt: null,
  lastAnswer: null,
  steps: [],
  changedFiles: [],
};

describe('AgentMessage', () => {
  it.each([
    { t: 'request', request, ttlMs: 0 },
    { t: 'snapshot', machine, sessions: [session], pending: [REQUEST_ID] },
    { t: 'resolved', requestId: REQUEST_ID, outcome: 'withdrawn' },
    { t: 'expired', requestId: REQUEST_ID },
    { t: 'decision_result', requestId: REQUEST_ID, result: 'accepted' },
    { t: 'decision_result', requestId: REQUEST_ID, result: 'rejected', reason: 'too_late' },
  ])('accepts $t', (message) => {
    expect(AgentMessage.parse(message)).toEqual(message);
  });

  it.each([
    ['a negative ttl', { t: 'request', request, ttlMs: -1 }],
    ['an unknown outcome', { t: 'resolved', requestId: REQUEST_ID, outcome: 'maybe' }],
    [
      'a rejection without a reason',
      { t: 'decision_result', requestId: REQUEST_ID, result: 'rejected' },
    ],
    [
      'a reason on an accepted decision',
      { t: 'decision_result', requestId: REQUEST_ID, result: 'accepted', reason: 'expired' },
    ],
    ['an unknown type', { t: 'hello' }],
    ['an extra field', { t: 'expired', requestId: REQUEST_ID, extra: 1 }],
  ])('refuses %s', (_name, message) => {
    expect(AgentMessage.safeParse(message).success).toBe(false);
  });

  it('lists the D7 rejections in check order', () => {
    expect(DecisionRejection.options).toEqual([
      'no_session',
      'unsupported',
      'unknown_request',
      'already_resolved',
      'hash_mismatch',
      'expired',
      'too_late',
      'wrong_peer',
      'unverified',
    ]);
  });
});

describe('PhoneMessage', () => {
  const decision = {
    v: 1,
    kind: 'deny',
    request_id: REQUEST_ID,
    request_hash: request.requestHash,
    issued_at: 1_791_763_200,
    expires_at: 1_791_763_200 + DECISION_TTL_SECONDS,
    phone_device_id: '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f',
    agent_device_id: MACHINE_ID,
    payload: null,
  };

  it('accepts a decision', () => {
    expect(PhoneMessage.parse({ t: 'decision', decision })).toEqual({ t: 'decision', decision });
  });

  it('refuses a decision that is not canonical', () => {
    const result = PhoneMessage.safeParse({
      t: 'decision',
      decision: { ...decision, expires_at: 0 },
    });
    expect(result.success).toBe(false);
  });
});

describe('PairingHello', () => {
  it('carries a trimmed device name', () => {
    expect(PairingHello.parse({ name: '  Pixel ' })).toEqual({ name: 'Pixel' });
    expect(PairingHello.safeParse({ name: ' ' }).success).toBe(false);
    expect(PairingHello.safeParse({ name: 'x'.repeat(65) }).success).toBe(false);
  });
});

describe('HANDSHAKE_TAG', () => {
  it('has distinct, frozen tags', () => {
    expect(HANDSHAKE_TAG).toEqual({ kk: 1, pairing: 2 });
    expect(Object.isFrozen(HANDSHAKE_TAG)).toBe(true);
  });
});
