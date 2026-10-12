import { Capabilities } from '@remote-control/protocol';
import { describe, expect, it } from 'vitest';

import type { PendingRequest } from '../../core/pending-store.js';
import { CLAUDE_CODE_CAPABILITIES, claudeCodeAdapter } from './adapter.js';
import { DEFAULT_DENY_MESSAGE, NO_DECISION_MESSAGE } from './decide.js';

// The `PermissionRequest` input documented in 04 §2.2, verbatim.
const PERMISSION_REQUEST = {
  session_id: 'abc123',
  transcript_path: '...',
  cwd: '/Users/...',
  permission_mode: 'default',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf node_modules', description: 'Remove node_modules directory' },
  permission_suggestions: [
    {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'rm -rf node_modules' }],
      behavior: 'allow',
      destination: 'localSettings',
    },
  ],
};

function pending(kind: PendingRequest['kind'], payload: Record<string, unknown>): PendingRequest {
  return {
    id: 'req_0123456789abcdef01234567',
    sessionId: 'abc123',
    kind,
    fingerprint: '',
    payload,
    createdAt: 0,
    deadline: 1_790_000,
  };
}

const permission = pending('permission', PERMISSION_REQUEST);

describe('claude-code adapter', () => {
  it('declares valid M0 capability flags (D12)', () => {
    expect(claudeCodeAdapter.id).toBe('claude-code');
    expect(Capabilities.parse(claudeCodeAdapter.capabilities)).toEqual(CLAUDE_CODE_CAPABILITIES);
    expect(CLAUDE_CODE_CAPABILITIES).toEqual({
      agent: 'claude-code',
      always: false,
      questions: false,
      instructions: false,
      startSession: false,
    });
  });

  describe('onHook', () => {
    it('maps the 04 §2.2 PermissionRequest to a permission event', () => {
      expect(claudeCodeAdapter.onHook(PERMISSION_REQUEST)).toEqual({
        kind: 'permission',
        sessionId: 'abc123',
        cwd: '/Users/...',
        toolName: 'Bash',
        toolInput: PERMISSION_REQUEST.tool_input,
        suggestions: PERMISSION_REQUEST.permission_suggestions,
        alwaysSupported: true,
      });
    });

    it('sets alwaysSupported only when Claude Code offers suggestions', () => {
      const bare: Record<string, unknown> = { ...PERMISSION_REQUEST };
      delete bare['permission_suggestions'];
      expect(claudeCodeAdapter.onHook(bare)).toMatchObject({
        suggestions: [],
        alwaysSupported: false,
      });
      expect(
        claudeCodeAdapter.onHook({ ...PERMISSION_REQUEST, permission_suggestions: [] }),
      ).toMatchObject({ alwaysSupported: false });
      expect(
        claudeCodeAdapter.onHook({
          ...bare,
          permission_suggestions: 'none',
          tool_input: undefined,
        }),
      ).toMatchObject({ suggestions: [], toolInput: null, alwaysSupported: false });
    });

    it('maps SessionStart and SessionEnd to registry seeds', () => {
      const common = { session_id: 's1', cwd: '/repo', transcript_path: '/t/s1.jsonl' };
      expect(
        claudeCodeAdapter.onHook({ ...common, hook_event_name: 'SessionStart', source: 'startup' }),
      ).toEqual({
        kind: 'session',
        phase: 'start',
        sessionId: 's1',
        cwd: '/repo',
        transcriptPath: '/t/s1.jsonl',
        detail: 'startup',
      });
      expect(
        claudeCodeAdapter.onHook({ session_id: 's1', cwd: '/repo', hook_event_name: 'SessionEnd' }),
      ).toEqual({ kind: 'session', phase: 'end', sessionId: 's1', cwd: '/repo' });
      expect(
        claudeCodeAdapter.onHook({ ...common, hook_event_name: 'SessionEnd', reason: 'logout' }),
      ).toMatchObject({ phase: 'end', detail: 'logout' });
    });

    it('returns null for unmapped or malformed input', () => {
      for (const raw of [
        null,
        'PermissionRequest',
        [PERMISSION_REQUEST],
        { ...PERMISSION_REQUEST, hook_event_name: 'Stop' },
        { ...PERMISSION_REQUEST, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' },
        { ...PERMISSION_REQUEST, session_id: '' },
        { ...PERMISSION_REQUEST, session_id: 7 },
        { ...PERMISSION_REQUEST, cwd: undefined },
        { ...PERMISSION_REQUEST, tool_name: '' },
        { ...PERMISSION_REQUEST, tool_name: undefined },
      ]) {
        expect(claudeCodeAdapter.onHook(raw)).toBeNull();
      }
    });
  });

  describe('decide', () => {
    it('produces the documented allow output (04 §2.2)', () => {
      expect(claudeCodeAdapter.decide(permission, { behavior: 'allow' })).toEqual({
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
      });
    });

    it('never carries updatedInput or updatedPermissions on allow (D11)', () => {
      const output = claudeCodeAdapter.decide(permission, { behavior: 'allow', message: 'x' });
      const decision = (output['hookSpecificOutput'] as { decision: Record<string, unknown> })
        .decision;
      expect(Object.keys(decision)).toEqual(['behavior']);
      expect(JSON.stringify(output)).not.toContain('updatedInput');
      expect(JSON.stringify(output)).not.toContain('updatedPermissions');
    });

    it('produces the documented deny output (04 §2.2)', () => {
      expect(
        claudeCodeAdapter.decide(permission, { behavior: 'deny', message: 'Denied from phone' }),
      ).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'deny', message: 'Denied from phone', interrupt: false },
        },
      });
      expect(claudeCodeAdapter.decide(permission, { behavior: 'deny' })).toMatchObject({
        hookSpecificOutput: { decision: { message: DEFAULT_DENY_MESSAGE, interrupt: false } },
      });
      expect(
        claudeCodeAdapter.decide(permission, { behavior: 'deny', message: NO_DECISION_MESSAGE }),
      ).toMatchObject({ hookSpecificOutput: { decision: { message: 'No decision from phone' } } });
    });

    it('hands off with an empty object (D10)', () => {
      expect(claudeCodeAdapter.decide(permission, { behavior: 'handoff' })).toEqual({});
    });

    it('hands off every decision on a question until M1-01', () => {
      const question = pending('question', {
        hook_event_name: 'PreToolUse',
        session_id: 'abc123',
        tool_name: 'AskUserQuestion',
      });
      for (const behavior of ['allow', 'deny', 'handoff'] as const) {
        expect(claudeCodeAdapter.decide(question, { behavior })).toEqual({});
      }
    });
  });
});
