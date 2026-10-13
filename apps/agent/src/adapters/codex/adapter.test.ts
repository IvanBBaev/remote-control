import { describe, expect, it } from 'vitest';

import type { PendingRequest } from '../../core/pending-store.js';
import type { AdapterDecision } from '../../ports/agent-adapter.js';
import { CODEX_CAPABILITIES, codexAdapter, codexHookEvent, decideCodex } from './adapter.js';

// A Codex `PermissionRequest` input with the 04 §2.11 fields.
const PERMISSION_INPUT = {
  session_id: '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b',
  transcript_path: '/home/synthetic/.codex/sessions/2026/10/13/rollout.jsonl',
  cwd: '/home/synthetic/repo',
  hook_event_name: 'PermissionRequest',
  model: 'gpt-5-codex',
  turn_id: 'turn_1',
  permission_mode: 'on-request',
  tool_name: 'shell',
  tool_use_id: 'call_1',
  tool_input: { command: ['rm', '-rf', 'node_modules'] },
};

function pending(kind: PendingRequest['kind'] = 'permission'): PendingRequest {
  return {
    id: 'req_0123456789abcdef01234567',
    sessionId: PERMISSION_INPUT.session_id,
    kind,
    fingerprint: '',
    payload: PERMISSION_INPUT,
    createdAt: 0,
    deadline: 1_790_000,
    agent: 'codex',
  };
}

const decide = (decision: AdapterDecision, kind?: PendingRequest['kind']): string =>
  JSON.stringify(decideCodex(pending(kind), decision));

describe('decideCodex — golden outputs (04 §2.11, §5.9)', () => {
  it('allows with the PermissionRequest decision shape, byte for byte', () => {
    expect(decide({ behavior: 'allow' })).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}',
    );
  });

  it('denies with the phone reason, or the default one', () => {
    expect(decide({ behavior: 'deny', message: 'Not on main' })).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Not on main"}}}',
    );
    expect(decide({ behavior: 'deny' })).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from phone"}}}',
    );
  });

  it('never rewrites the tool input (D11)', () => {
    const output = JSON.parse(decide({ behavior: 'allow' })) as {
      hookSpecificOutput: { decision: unknown };
    };
    expect(output.hookSpecificOutput.decision).toEqual({ behavior: 'allow' });
  });

  it.each<AdapterDecision>([
    { behavior: 'handoff' },
    { behavior: 'always' },
    { behavior: 'answer', answer: { answers: { q: 'a' } } },
  ])('hands off on $behavior (no rules, no questions in Codex hooks)', (decision) => {
    expect(decide(decision)).toBe('{}');
  });

  it('hands off for a question request, which Codex never sends', () => {
    expect(decide({ behavior: 'allow' }, 'question')).toBe('{}');
    expect(decide({ behavior: 'deny' }, 'question')).toBe('{}');
  });
});

describe('codexHookEvent', () => {
  it('maps a PermissionRequest without "always" suggestions', () => {
    expect(codexHookEvent(PERMISSION_INPUT)).toEqual({
      kind: 'permission',
      sessionId: PERMISSION_INPUT.session_id,
      cwd: PERMISSION_INPUT.cwd,
      toolName: 'shell',
      toolInput: PERMISSION_INPUT.tool_input,
      suggestions: [],
      alwaysSupported: false,
    });
  });

  it('maps SessionStart and SessionEnd', () => {
    const base = { session_id: 's1', cwd: '/r', transcript_path: '/t.jsonl', model: 'm' };
    expect(codexHookEvent({ ...base, hook_event_name: 'SessionStart' })).toEqual({
      kind: 'session',
      phase: 'start',
      sessionId: 's1',
      cwd: '/r',
      transcriptPath: '/t.jsonl',
    });
    expect(codexHookEvent({ ...base, hook_event_name: 'SessionEnd' })).toMatchObject({
      phase: 'end',
    });
  });

  it('returns null for unmapped or malformed input', () => {
    expect(codexHookEvent({ ...PERMISSION_INPUT, hook_event_name: 'PreToolUse' })).toBeNull();
    expect(codexHookEvent({ ...PERMISSION_INPUT, session_id: '' })).toBeNull();
    expect(codexHookEvent({ ...PERMISSION_INPUT, tool_name: 7 })).toBeNull();
    expect(codexHookEvent('nope')).toBeNull();
  });
});

describe('codexAdapter', () => {
  it('offers approvals only (M2-01: no questions, always, follow-up or start)', () => {
    expect(codexAdapter.id).toBe('codex');
    expect(CODEX_CAPABILITIES).toEqual({
      agent: 'codex',
      always: false,
      questions: false,
      instructions: false,
      startSession: false,
    });
    expect(Object.isFrozen(codexAdapter)).toBe(true);
  });
});
