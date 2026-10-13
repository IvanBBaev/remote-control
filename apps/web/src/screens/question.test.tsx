import type { Question, QuestionItem } from '@remote-control/protocol';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MachineView, QuestionView, RequestUpdate } from '../realtime/realtime-store.js';
import { createTestPhone } from '../realtime/test-phone.js';
import type { TestPhone } from '../realtime/test-phone.js';
import { fixtures } from '../test-fixtures.js';
import { click, renderApp, settle, type } from '../test-render.js';
import type { RenderedApp } from '../test-render.js';
import { TAP_GUARD_MS } from './approval.js';
import { answerPayload, picked } from './question.js';

const AGENT = 'agent-1';
const ID = '0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';

const FRAMEWORK: QuestionItem = {
  text: 'Which framework?',
  header: 'Framework',
  options: [
    { label: 'React', description: 'Component library' },
    { label: 'Vue', description: 'Progressive framework' },
  ],
  multi: false,
};
const CHECKS: QuestionItem = {
  text: 'Which checks?',
  options: [{ label: 'lint' }, { label: 'test' }, { label: 'build' }],
  multi: true,
};

const machine: MachineView = {
  deviceId: AGENT,
  name: 'Studio Mac',
  online: true,
  lastSeen: null,
  session: 'open',
  machine: null,
  sessions: [],
  history: null,
};

let mounted: RenderedApp | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

function question(change: Partial<Question> = {}): Question {
  return {
    id: ID,
    sessionId: 'sess-1',
    requestHash: 'a'.repeat(64),
    expiresAt: 0,
    questions: [FRAMEWORK, CHECKS],
    ...change,
  };
}

async function open(change: (test: TestPhone) => Partial<QuestionView> = () => ({})) {
  const test = createTestPhone();
  vi.spyOn(test.phone, 'connect').mockResolvedValue();
  const answer = vi.spyOn(test.phone, 'answer');
  const decide = vi.spyOn(test.phone, 'decide');
  const view: QuestionView = {
    machineId: AGENT,
    kind: 'question',
    request: question(),
    deadline: test.timer.now() + 120_000,
    status: 'pending',
    ...change(test),
  };
  test.phone.realtime.setState({
    connection: 'open',
    machines: { [AGENT]: machine },
    requests: { [ID]: view },
  });
  mounted = await renderApp(`/requests/${ID}`, fixtures.onboarded, { phone: test.phone });
  return { test, answer, decide };
}

const text = () => mounted?.container.textContent ?? '';
const tick = (test: TestPhone, ms: number) => {
  act(() => {
    test.timer.advance(ms);
  });
};
const set = (test: TestPhone, change: RequestUpdate) => {
  act(() => {
    const current = test.phone.realtime.getState().requests[ID]!;
    test.phone.realtime.setState({ requests: { [ID]: { ...current, ...change } } });
  });
};
const choice = (label: string): HTMLInputElement => {
  const found = [...(mounted?.container.querySelectorAll('label.question-option') ?? [])].find(
    (entry) => entry.querySelector('span')?.firstChild?.textContent === label,
  );
  if (found === undefined) throw new Error(`no choice "${label}"`);
  return found.querySelector('input')!;
};
const otherText = () =>
  mounted?.container.querySelector<HTMLInputElement>('input[aria-label="Your answer"]') ?? null;
async function typeNote(value: string): Promise<void> {
  const note = mounted!.container.querySelector('textarea')!;
  await act(async () => {
    Reflect.set(HTMLTextAreaElement.prototype, 'value', value, note);
    note.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

describe('question helpers', () => {
  it('knows when a question is picked', () => {
    expect(picked(FRAMEWORK, { labels: [] })).toBe(false);
    expect(picked(FRAMEWORK, { labels: ['React'] })).toBe(true);
    expect(picked(FRAMEWORK, { labels: [], other: 'Svelte' })).toBe(true);
    expect(picked(FRAMEWORK, { labels: [], other: '  ' })).toBe(false);
    expect(picked(CHECKS, { labels: [] })).toBe(false);
    expect(picked(CHECKS, { labels: ['lint', 'test'], other: 'e2e' })).toBe(true);
  });

  it('builds the payload in question order with trimmed free text', () => {
    expect(
      answerPayload([{ labels: ['React'] }, { labels: ['lint'], other: ' e2e ' }], ' '),
    ).toEqual({ answers: [{ labels: ['React'] }, { labels: ['lint'], other: 'e2e' }] });
    expect(answerPayload([{ labels: ['Vue'] }], ' Thanks ')).toEqual({
      answers: [{ labels: ['Vue'] }],
      response: 'Thanks',
    });
  });
});

describe('question card', () => {
  it('titles the screen and shows the first question with its options', async () => {
    await open();
    expect(mounted?.container.querySelector('h1')?.textContent).toBe('Question');
    expect(mounted?.container.querySelector('.question-card .meta')?.textContent).toBe(
      'Studio Mac',
    );
    expect(text()).toContain('Question 1 of 2');
    expect(text()).toContain('Framework');
    expect(mounted?.container.querySelector('h2')?.textContent).toBe('Which framework?');
    expect(choice('React').type).toBe('radio');
    const described = choice('Vue').getAttribute('aria-describedby')!;
    expect(mounted?.container.querySelector(`[id="${described}"]`)?.textContent).toBe(
      'Progressive framework',
    );
    expect(text()).not.toContain('Note for the agent');
    expect(mounted!.button('Back').disabled).toBe(true);
    expect(mounted!.button('Next').disabled).toBe(true);
    expect(text()).toContain('Time left: 2:00');
  });

  it('shows the project and no step count for a single question', async () => {
    await open(() => ({ request: question({ project: 'api', questions: [CHECKS] }) }));
    expect(mounted?.container.querySelector('.question-card .meta')?.textContent).toBe(
      'Studio Mac · api',
    );
    expect(text()).not.toContain('Question 1 of');
    expect(text()).toContain('Choose one or more.');
    expect(choice('lint').type).toBe('checkbox');
    expect(choice('lint').hasAttribute('aria-describedby')).toBe(false);
    expect(text()).toContain('Note for the agent (optional)');
  });

  it('names an unknown computer', async () => {
    await open(() => ({ machineId: 'gone' }));
    expect(text()).toContain('Unknown computer');
  });

  it('steps through the questions and sends the answer with the note', async () => {
    const { test, answer } = await open();
    tick(test, TAP_GUARD_MS);
    answer.mockResolvedValue({ ok: true, decisionHash: 'h', asserted: true });
    await click(choice('React'));
    await click(choice('Vue'));
    expect(choice('React').checked).toBe(false);
    await click(mounted!.button('Next'));
    expect(text()).toContain('Question 2 of 2');
    expect(mounted!.button('Send answer').disabled).toBe(true);
    await click(choice('lint'));
    await click(choice('test'));
    await click(choice('lint'));
    await click(choice('build'));
    await click(mounted!.button('Back'));
    expect(choice('Vue').checked).toBe(true);
    await click(mounted!.button('Next'));
    expect(choice('test').checked).toBe(true);
    await typeNote('Keep it small');
    await click(mounted!.button('Send answer'));
    expect(answer).toHaveBeenCalledWith(AGENT, question(), {
      answers: [{ labels: ['Vue'] }, { labels: ['test', 'build'] }],
      response: 'Keep it small',
    });
    expect(text()).toContain('Answer sent. Waiting for your computer…');
    expect(() => mounted!.button('Send answer')).toThrow();
  });

  it('takes "Other" free text, alone for single-select and next to labels for multi', async () => {
    const { test, answer } = await open();
    tick(test, TAP_GUARD_MS);
    answer.mockResolvedValue({ ok: true, decisionHash: 'h', asserted: true });
    await click(choice('React'));
    expect(otherText()).toBeNull();
    await click(choice('Other'));
    expect(choice('React').checked).toBe(false);
    expect(mounted!.button('Next').disabled).toBe(true);
    await type(otherText()!, '   ');
    expect(mounted!.button('Next').disabled).toBe(true);
    await type(otherText()!, 'Svelte');
    expect(mounted!.button('Next').disabled).toBe(false);
    await click(mounted!.button('Next'));
    await click(choice('Other'));
    await type(otherText()!, 'e2e');
    await click(choice('lint'));
    await click(choice('Other'));
    expect(otherText()).toBeNull();
    await click(choice('Other'));
    await type(otherText()!, 'e2e');
    await click(mounted!.button('Send answer'));
    expect(answer).toHaveBeenCalledWith(AGENT, expect.anything(), {
      answers: [
        { labels: [], other: 'Svelte' },
        { labels: ['lint'], other: 'e2e' },
      ],
    });
  });

  it('ignores taps right after the card appears', async () => {
    const { test, answer } = await open(() => ({ request: question({ questions: [FRAMEWORK] }) }));
    await click(choice('React'));
    await click(mounted!.button('Send answer'));
    expect(answer).not.toHaveBeenCalled();
    tick(test, TAP_GUARD_MS);
    answer.mockResolvedValue({ ok: true, decisionHash: 'h', asserted: true });
    await click(mounted!.button('Send answer'));
    expect(answer).toHaveBeenCalledOnce();
  });

  it('sends one answer at a time', async () => {
    const { test, answer } = await open(() => ({ request: question({ questions: [FRAMEWORK] }) }));
    tick(test, TAP_GUARD_MS);
    let finish: (value: { ok: true; decisionHash: string; asserted: boolean }) => void = () =>
      undefined;
    answer.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await click(choice('React'));
    await click(mounted!.button('Send answer'));
    expect(mounted!.button('Send answer').disabled).toBe(true);
    expect(mounted!.button('Deny').disabled).toBe(true);
    await click(mounted!.button('Send answer'));
    expect(answer).toHaveBeenCalledOnce();
    await act(async () => {
      finish({ ok: true, decisionHash: 'h', asserted: true });
      await Promise.resolve();
    });
    await settle();
    expect(text()).toContain('Answer sent.');
  });

  it('denies a question', async () => {
    const { test, decide } = await open();
    tick(test, TAP_GUARD_MS);
    decide.mockResolvedValue({ ok: true, decisionHash: 'h', asserted: false });
    await click(mounted!.button('Deny'));
    expect(decide).toHaveBeenCalledWith(AGENT, question(), 'deny');
    expect(text()).toContain('Deny sent. Waiting for your computer…');
  });

  it('AC: "Reply in terminal" hands the question back without a passkey (M1-03)', async () => {
    const { test, answer, decide } = await open();
    const release = vi
      .spyOn(test.phone, 'release')
      .mockResolvedValue({ ok: true, decisionHash: 'h', asserted: false });
    await click(mounted!.button('Reply in terminal'));
    expect(release).not.toHaveBeenCalled();
    tick(test, TAP_GUARD_MS);
    await click(mounted!.button('Reply in terminal'));
    expect(release).toHaveBeenCalledWith(AGENT, question());
    expect(answer).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    expect(text()).toContain('Reply in terminal sent. Waiting for your computer…');
    expect(() => mounted!.button('Reply in terminal')).toThrow();
    set(test, { result: { t: 'decision_result', requestId: ID, result: 'accepted' } });
    expect(text()).toContain('Handed back to the terminal. Answer it on your computer.');
    expect(text()).not.toContain('Time left');
  });

  it.each([
    ['cancelled', 'Face ID was cancelled. Nothing was sent.'],
    ['offline', 'You are offline. Nothing was sent.'],
  ] as const)('explains a %s failure and lets the user retry', async (failure, message) => {
    const { test, answer } = await open(() => ({ request: question({ questions: [FRAMEWORK] }) }));
    tick(test, TAP_GUARD_MS);
    answer.mockResolvedValue({ ok: false, failure });
    await click(choice('React'));
    await click(mounted!.button('Send answer'));
    expect(mounted?.container.querySelector('.notice.error')?.textContent).toContain(message);
    expect(mounted!.button('Send answer').disabled).toBe(false);
  });

  it('expires locally when the countdown runs out', async () => {
    const { test } = await open((t) => ({ deadline: t.timer.now() + 1500 }));
    tick(test, 1000);
    tick(test, 500);
    expect(text()).toContain('Expired. The terminal is asking again.');
    expect(() => mounted!.button('Next')).toThrow();
    expect(mounted?.container.querySelector('fieldset')?.disabled).toBe(true);
  });

  it.each<[string, RequestUpdate, string]>([
    ['answered', { status: 'resolved', outcome: 'answer' }, 'Answered.'],
    ['denied', { status: 'resolved', outcome: 'deny' }, 'Denied.'],
    [
      'handed back to the terminal',
      { status: 'resolved', outcome: 'terminal' },
      'Handed back to the terminal.',
    ],
    [
      'with an answer the computer could not use',
      {
        result: {
          t: 'decision_result',
          requestId: ID,
          result: 'rejected',
          reason: 'invalid_answer',
        },
      },
      'Your computer could not use that answer. Answer it in the terminal.',
    ],
  ])('shows a question %s', async (_label, change, message) => {
    const { test } = await open();
    set(test, change);
    expect(text()).toContain(message);
    expect(() => mounted!.button('Deny')).toThrow();
    expect(text()).not.toContain('Time left');
  });
});
