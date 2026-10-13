import { describe, expect, it } from 'vitest';

import type { PendingRequest } from './pending-store.js';
import { questionAnswers, questionView } from './question-view.js';

const HASH = 'a'.repeat(64);
const ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

const FRAMEWORK = {
  question: 'Which framework?',
  header: 'Framework',
  options: [
    { label: 'React', description: 'Component library' },
    { label: 'Vue', description: 'Progressive framework' },
  ],
  multiSelect: false,
};
const CHECKS = {
  question: 'Which checks?',
  options: [{ label: 'lint' }, { label: 'test' }, { label: 'build', extra: true }],
  multiSelect: true,
};

function request(
  toolInput: unknown,
  overrides: Partial<PendingRequest> = {},
  cwd: unknown = '/Users/me/work/remote-control',
): PendingRequest {
  return {
    id: ID,
    sessionId: 'sess-1',
    kind: 'question',
    fingerprint: '',
    payload: {
      session_id: 'sess-1',
      cwd,
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: toolInput,
    },
    createdAt: 0,
    deadline: 1_790_000,
    ...overrides,
  };
}

const both = request({ questions: [FRAMEWORK, CHECKS] });

describe('questionView', () => {
  it('maps the questions, header, option descriptions and multiSelect', () => {
    expect(questionView(both, HASH)).toEqual({
      id: ID,
      sessionId: 'sess-1',
      requestHash: HASH,
      project: 'remote-control',
      expiresAt: 1_790_000,
      questions: [
        {
          text: 'Which framework?',
          header: 'Framework',
          options: [
            { label: 'React', description: 'Component library' },
            { label: 'Vue', description: 'Progressive framework' },
          ],
          multi: false,
        },
        {
          text: 'Which checks?',
          options: [{ label: 'lint' }, { label: 'test' }, { label: 'build' }],
          multi: true,
        },
      ],
    });
  });

  it('leaves out the project when there is no folder name', () => {
    expect(questionView(request({ questions: [CHECKS] }, {}, 7), HASH)).not.toHaveProperty(
      'project',
    );
  });

  it.each<[string, PendingRequest]>([
    ['a permission request', request({ questions: [FRAMEWORK] }, { kind: 'permission' })],
    ['no tool input', request(null)],
    ['no questions', request({ questions: [] })],
    [
      'five questions',
      request({ questions: [1, 2, 3, 4, 5].map((n) => ({ ...CHECKS, question: `Q${n}?` })) }),
    ],
    ['one option', request({ questions: [{ ...FRAMEWORK, options: [{ label: 'React' }] }] })],
    [
      'five options',
      request({
        questions: [
          { ...FRAMEWORK, options: ['1', '2', '3', '4', '5'].map((label) => ({ label })) },
        ],
      }),
    ],
    ['a repeated question text', request({ questions: [FRAMEWORK, FRAMEWORK] })],
    ['an empty question text', request({ questions: [{ ...FRAMEWORK, question: '' }] })],
    ['a bad session id', request({ questions: [FRAMEWORK] }, { sessionId: '' })],
    ['a bad request id', request({ questions: [FRAMEWORK] }, { id: 'req-1' })],
  ])('is undefined for %s', (_name, pendingRequest) => {
    expect(questionView(pendingRequest, HASH)).toBeUndefined();
  });
});

describe('questionAnswers', () => {
  it('keys the answers by question text, labels then "Other" joined with ", "', () => {
    expect(
      questionAnswers(both, {
        answers: [{ labels: ['React'] }, { labels: ['test', 'lint'], other: 'e2e' }],
      }),
    ).toEqual({ answers: { 'Which framework?': 'React', 'Which checks?': 'test, lint, e2e' } });
  });

  it('takes "Other" alone for a single-select question and keeps the response', () => {
    expect(
      questionAnswers(both, {
        answers: [{ labels: [], other: 'Svelte' }, { labels: ['build'] }],
        response: 'More next time',
      }),
    ).toEqual({
      answers: { 'Which framework?': 'Svelte', 'Which checks?': 'build' },
      response: 'More next time',
    });
  });

  it.each([
    ['too few answers', { answers: [{ labels: ['React'] }] }],
    [
      'too many answers',
      { answers: [{ labels: ['React'] }, { labels: ['lint'] }, { labels: ['test'] }] },
    ],
    ['an unknown label', { answers: [{ labels: ['Angular'] }, { labels: ['lint'] }] }],
    ['a repeated label', { answers: [{ labels: ['React'] }, { labels: ['lint', 'lint'] }] }],
    [
      'two choices for single-select',
      { answers: [{ labels: ['React', 'Vue'] }, { labels: ['lint'] }] },
    ],
    [
      'a label and "Other" for single-select',
      { answers: [{ labels: ['React'], other: 'Svelte' }, { labels: ['lint'] }] },
    ],
    ['nothing for single-select', { answers: [{ labels: [] }, { labels: ['lint'] }] }],
    ['nothing for multi-select', { answers: [{ labels: ['React'] }, { labels: [] }] }],
  ])('is undefined for %s', (_name, payload) => {
    expect(questionAnswers(both, payload)).toBeUndefined();
  });

  it('is undefined for a request that is not an answerable question', () => {
    const payload = { answers: [{ labels: ['React'] }] };
    expect(
      questionAnswers(request({ questions: [FRAMEWORK] }, { kind: 'permission' }), payload),
    ).toBeUndefined();
    expect(
      questionAnswers(request({ questions: [FRAMEWORK, FRAMEWORK] }), payload),
    ).toBeUndefined();
  });
});
