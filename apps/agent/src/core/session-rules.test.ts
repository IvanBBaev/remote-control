import { describe, expect, it } from 'vitest';

import type { PendingRequest } from './pending-store.js';
import { ruleLabel, sessionRuleLabels, sessionRules } from './session-rules.js';

// The 04 §2.2 example suggestion: Claude Code proposes the local settings file.
const SUGGESTION = {
  type: 'addRules',
  rules: [{ toolName: 'Bash', ruleContent: 'rm -rf node_modules' }],
  behavior: 'allow',
  destination: 'localSettings',
};

function pending(suggestions: unknown, kind: PendingRequest['kind'] = 'permission') {
  return {
    id: 'r1',
    sessionId: 's1',
    kind,
    fingerprint: 'f',
    payload: { tool_name: 'Bash', permission_suggestions: suggestions },
    createdAt: 0,
    deadline: 1,
  } satisfies PendingRequest;
}

describe('sessionRules (D24)', () => {
  it('re-targets every suggested allow rule to the session, whatever was proposed', () => {
    const updates = sessionRules(
      pending([
        SUGGESTION,
        { ...SUGGESTION, rules: [{ toolName: 'Read' }], destination: 'projectSettings' },
      ]),
    );
    expect(updates).toEqual([
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'rm -rf node_modules' }],
        behavior: 'allow',
        destination: 'session',
      },
      {
        type: 'addRules',
        rules: [{ toolName: 'Read' }],
        behavior: 'allow',
        destination: 'session',
      },
    ]);
    expect(sessionRuleLabels(updates)).toEqual(['Bash(rm -rf node_modules)', 'Read']);
    expect(JSON.stringify(updates)).not.toMatch(/Settings/);
  });

  it('offers nothing without suggestions or for a question', () => {
    expect(sessionRules(pending(undefined))).toEqual([]);
    expect(sessionRules(pending([]))).toEqual([]);
    expect(sessionRules(pending({ 0: SUGGESTION }))).toEqual([]);
    expect(sessionRules(pending([SUGGESTION], 'question'))).toEqual([]);
  });

  it('skips mode changes, directory grants and deny or ask rules', () => {
    expect(
      sessionRules(
        pending([
          { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
          { type: 'addDirectories', directories: ['/'], destination: 'session' },
          { ...SUGGESTION, behavior: 'deny' },
          { ...SUGGESTION, behavior: 'ask' },
          { ...SUGGESTION, type: 'replaceRules' },
        ]),
      ),
    ).toEqual([]);
  });

  it.each([
    ['a suggestion that is not an object', ['addRules']],
    ['a rule list that is missing', [{ ...SUGGESTION, rules: undefined }]],
    ['an empty rule list', [{ ...SUGGESTION, rules: [] }]],
    ['a rule without a tool name', [{ ...SUGGESTION, rules: [{ ruleContent: 'ls' }] }]],
    ['an empty tool name', [{ ...SUGGESTION, rules: [{ toolName: '' }] }]],
    [
      'rule content that is not text',
      [{ ...SUGGESTION, rules: [{ toolName: 'Bash', ruleContent: 1 }] }],
    ],
    [
      'a rule the phone cannot show in full',
      [{ ...SUGGESTION, rules: [{ toolName: 'Bash', ruleContent: 'x'.repeat(195) }] }],
    ],
    [
      'more rules than the phone shows',
      [{ ...SUGGESTION, rules: Array.from({ length: 11 }, () => ({ toolName: 'Read' })) }],
    ],
  ])('fails closed on %s, even beside a good suggestion', (_, bad) => {
    expect(sessionRules(pending([SUGGESTION, ...bad]))).toEqual([]);
  });

  it('labels a rule in Claude Code notation', () => {
    expect(ruleLabel({ toolName: 'Bash', ruleContent: 'npm test' })).toBe('Bash(npm test)');
    expect(ruleLabel({ toolName: 'WebFetch' })).toBe('WebFetch');
  });
});
