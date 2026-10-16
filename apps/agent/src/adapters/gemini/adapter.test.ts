import { describe, expect, it } from 'vitest';

import type { PendingRequest } from '../../core/pending-store.js';
import type { AdapterDecision } from '../../ports/agent-adapter.js';
import { GEMINI_CAPABILITIES, decideGemini, geminiAdapter, geminiHookEvent } from './adapter.js';

// A Gemini `BeforeTool` input with the 04 §2.12 fields.
const BEFORE_TOOL_INPUT = {
  session_id: 'c0ffee00-1111-4222-8333-444455556666',
  transcript_path: '/home/synthetic/.gemini/tmp/chats/session.json',
  cwd: '/home/synthetic/repo',
  hook_event_name: 'BeforeTool',
  timestamp: '2026-10-14T09:00:00.000Z',
  tool_name: 'run_shell_command',
  tool_input: { command: 'rm -rf node_modules' },
};

function pending(kind: PendingRequest['kind'] = 'permission'): PendingRequest {
  return {
    id: 'req_0123456789abcdef01234567',
    sessionId: BEFORE_TOOL_INPUT.session_id,
    kind,
    fingerprint: '',
    payload: BEFORE_TOOL_INPUT,
    createdAt: 0,
    deadline: 1_790_000,
    agent: 'gemini',
  };
}

const decide = (decision: AdapterDecision, kind?: PendingRequest['kind']): string =>
  JSON.stringify(decideGemini(pending(kind), decision));

describe('decideGemini — golden outputs (04 §2.12, §5.9)', () => {
  it('denies with the phone reason, or the default one', () => {
    expect(decide({ behavior: 'deny', message: 'Not on main' })).toBe(
      '{"decision":"deny","reason":"Not on main"}',
    );
    expect(decide({ behavior: 'deny' })).toBe('{"decision":"deny","reason":"Denied from phone"}');
  });

  it.each<AdapterDecision>([
    { behavior: 'allow' },
    { behavior: 'handoff' },
    { behavior: 'always' },
    { behavior: 'answer', answer: { answers: { q: 'a' } } },
  ])('never grants: $behavior leaves the call to Gemini’s own confirmation', (decision) => {
    expect(decide(decision)).toBe('{}');
  });

  it('hands off for a question request, which Gemini never sends', () => {
    expect(decide({ behavior: 'deny' }, 'question')).toBe('{}');
  });
});

describe('geminiHookEvent', () => {
  it('maps BeforeTool to a permission without "always" suggestions', () => {
    expect(geminiHookEvent(BEFORE_TOOL_INPUT)).toEqual({
      kind: 'permission',
      sessionId: BEFORE_TOOL_INPUT.session_id,
      cwd: BEFORE_TOOL_INPUT.cwd,
      toolName: 'run_shell_command',
      toolInput: BEFORE_TOOL_INPUT.tool_input,
      suggestions: [],
      alwaysSupported: false,
    });
  });

  it('maps SessionStart and SessionEnd', () => {
    const base = { session_id: 's1', cwd: '/r', transcript_path: '/t.json', timestamp: 't' };
    expect(geminiHookEvent({ ...base, hook_event_name: 'SessionStart' })).toEqual({
      kind: 'session',
      phase: 'start',
      sessionId: 's1',
      cwd: '/r',
      transcriptPath: '/t.json',
    });
    expect(geminiHookEvent({ ...base, hook_event_name: 'SessionEnd' })).toMatchObject({
      phase: 'end',
    });
  });

  it('returns null for unmapped or malformed input', () => {
    expect(geminiHookEvent({ ...BEFORE_TOOL_INPUT, hook_event_name: 'AfterTool' })).toBeNull();
    expect(geminiHookEvent({ ...BEFORE_TOOL_INPUT, session_id: '' })).toBeNull();
    expect(geminiHookEvent({ ...BEFORE_TOOL_INPUT, tool_name: 7 })).toBeNull();
    expect(geminiHookEvent('nope')).toBeNull();
  });
});

describe('geminiAdapter', () => {
  it('offers nothing beyond deny (04 A6: no allow, questions, always, follow-up or start)', () => {
    expect(geminiAdapter.id).toBe('gemini');
    expect(GEMINI_CAPABILITIES).toEqual({
      agent: 'gemini',
      allow: false,
      always: false,
      questions: false,
      instructions: false,
      startSession: false,
    });
    expect(Object.isFrozen(geminiAdapter)).toBe(true);
  });
});
