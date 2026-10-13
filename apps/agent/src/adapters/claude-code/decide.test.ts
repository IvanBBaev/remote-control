import { describe, expect, it } from 'vitest';

import type { PendingRequest } from '../../core/pending-store.js';
import type { AdapterDecision } from '../../ports/agent-adapter.js';
import { DEFAULT_DENY_MESSAGE, NO_DECISION_MESSAGE, decideClaudeCode } from './decide.js';

// The `AskUserQuestion` tool input of the 04 §2.3 example, verbatim.
const TOOL_INPUT = {
  questions: [
    {
      question: 'Which framework?',
      header: 'Framework',
      options: [
        { label: 'React', description: 'Component library' },
        { label: 'Vue', description: 'Progressive framework' },
      ],
      multiSelect: false,
    },
  ],
};

// The 04 §2.3 hook output, byte for byte (the report wraps it over four lines).
const GOLDEN =
  '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow",' +
  '"updatedInput":{"questions":[{"question":"Which framework?","header":"Framework",' +
  '"options":[{"label":"React","description":"Component library"},{"label":"Vue","description":"Progressive framework"}],' +
  '"multiSelect":false}],"answers":{"Which framework?":"React"}}}}';

function pending(
  kind: PendingRequest['kind'],
  payload: Readonly<Record<string, unknown>>,
): PendingRequest {
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

const question = pending('question', {
  session_id: 'abc123',
  cwd: '/repo',
  hook_event_name: 'PreToolUse',
  tool_name: 'AskUserQuestion',
  tool_input: TOOL_INPUT,
});
const bash = pending('permission', {
  session_id: 'abc123',
  cwd: '/repo',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
});
const answer: AdapterDecision = {
  behavior: 'answer',
  answer: { answers: { 'Which framework?': 'React' } },
};

describe('decideClaudeCode', () => {
  describe('answering AskUserQuestion (M1-01, D11)', () => {
    it('reproduces the 04 §2.3 output byte for byte', () => {
      expect(JSON.stringify(decideClaudeCode(question, answer))).toBe(GOLDEN);
    });

    it('returns the questions exactly as Claude Code sent them', () => {
      const output = decideClaudeCode(question, answer) as {
        hookSpecificOutput: { updatedInput: { questions: unknown } };
      };
      expect(output.hookSpecificOutput.updatedInput.questions).toBe(TOOL_INPUT.questions);
    });

    it('adds the free-text response when there is one', () => {
      const output = decideClaudeCode(question, {
        behavior: 'answer',
        answer: { answers: { 'Which framework?': 'Svelte' }, response: 'See the notes' },
      });
      expect(output).toMatchObject({
        hookSpecificOutput: {
          updatedInput: { answers: { 'Which framework?': 'Svelte' }, response: 'See the notes' },
        },
      });
    });

    it('denies a question through PreToolUse', () => {
      expect(decideClaudeCode(question, { behavior: 'deny' })).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: DEFAULT_DENY_MESSAGE,
        },
      });
      expect(
        decideClaudeCode(question, { behavior: 'deny', message: NO_DECISION_MESSAGE }),
      ).toMatchObject({ hookSpecificOutput: { permissionDecisionReason: NO_DECISION_MESSAGE } });
    });

    it('hands off a question on handoff, allow, or an answer without answers (D10)', () => {
      for (const decision of [
        { behavior: 'handoff' },
        { behavior: 'allow' },
        { behavior: 'answer' },
      ] as const) {
        expect(decideClaudeCode(question, decision)).toEqual({});
      }
    });

    it('hands off a question whose tool is not AskUserQuestion or has no input', () => {
      for (const payload of [
        { ...question.payload, tool_name: 'Bash' },
        { ...question.payload, tool_input: null },
        { ...question.payload, tool_input: 'questions' },
      ]) {
        expect(decideClaudeCode(pending('question', payload), answer)).toEqual({});
      }
    });
  });

  describe('updatedInput only for AskUserQuestion (D11)', () => {
    it('never emits updatedInput for a permission request, whatever the decision', () => {
      for (const decision of [
        answer,
        { behavior: 'allow', message: 'x', answer: answer.answer },
        { behavior: 'deny' },
        { behavior: 'handoff' },
        { behavior: 'always' },
      ] satisfies AdapterDecision[]) {
        const text = JSON.stringify(decideClaudeCode(bash, decision));
        expect(text).not.toContain('updatedInput');
        expect(text).not.toContain('updatedPermissions');
      }
    });

    it('hands off an answer decision for a permission request', () => {
      expect(decideClaudeCode(bash, answer)).toEqual({});
    });

    it('approves a permission with the tool input unchanged', () => {
      const output = decideClaudeCode(bash, { behavior: 'allow', answer: answer.answer });
      expect(output).toEqual({
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
      });
    });
  });

  describe('"Always" from the phone (M1-02, D24)', () => {
    const suggested = pending('permission', {
      ...bash.payload,
      permission_suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'ls' }],
          behavior: 'allow',
          destination: 'localSettings',
        },
        { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      ],
    });

    it('allows with the suggested rules, every one for this session only', () => {
      expect(decideClaudeCode(suggested, { behavior: 'always' })).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'allow',
            updatedPermissions: [
              {
                type: 'addRules',
                rules: [{ toolName: 'Bash', ruleContent: 'ls' }],
                behavior: 'allow',
                destination: 'session',
              },
            ],
          },
        },
      });
      const text = JSON.stringify(decideClaudeCode(suggested, { behavior: 'always' }));
      expect(text).not.toMatch(/localSettings|projectSettings|userSettings|setMode/);
      expect(text).not.toContain('updatedInput');
    });

    it('hands off "Always" when the request suggested no rule (D10)', () => {
      expect(decideClaudeCode(bash, { behavior: 'always' })).toEqual({});
    });

    it('emits no rule for a plain allow, even when rules were suggested', () => {
      expect(JSON.stringify(decideClaudeCode(suggested, { behavior: 'allow' }))).not.toContain(
        'updatedPermissions',
      );
    });

    it('hands off "Always" for a question', () => {
      expect(decideClaudeCode(question, { behavior: 'always' })).toEqual({});
    });
  });
});
