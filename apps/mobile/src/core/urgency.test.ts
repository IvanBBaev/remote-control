import { describe, expect, it } from 'vitest';

import { fixtureInbox } from './fixtures';
import type { AgentSession } from './model';
import { deadlineOf, sortByUrgency, stateOf, waitingCount } from './urgency';

const NOW = 1_800_000_000_000;

function session(overrides: Partial<AgentSession> & Pick<AgentSession, 'id'>): AgentSession {
  return {
    machine: 'm',
    project: 'p',
    title: 't',
    status: 'idle',
    updatedAt: NOW,
    ...overrides,
  };
}

const approval = (expiresAt: number) => ({
  requestId: 'r',
  toolLabel: 'Run a command',
  toolKind: 'command' as const,
  detail: 'ls',
  cwd: '~',
  expiresAt,
  canAlways: false,
});

const question = (expiresAt: number) => ({
  requestId: 'q',
  header: 'H',
  prompt: 'P?',
  options: [{ label: 'A' }],
  expiresAt,
});

describe('stateOf', () => {
  it('puts a pending approval before a pending question and the session status', () => {
    expect(
      stateOf(
        session({ id: 'a', status: 'error', approval: approval(NOW), question: question(NOW) }),
      ),
    ).toBe('needs-ok');
    expect(stateOf(session({ id: 'b', status: 'error', question: question(NOW) }))).toBe(
      'question',
    );
    expect(stateOf(session({ id: 'c', status: 'done' }))).toBe('done');
  });
});

describe('deadlineOf', () => {
  it('reads the approval, then the question, else nothing', () => {
    expect(deadlineOf(session({ id: 'a', approval: approval(5) }))).toBe(5);
    expect(deadlineOf(session({ id: 'b', question: question(7) }))).toBe(7);
    expect(deadlineOf(session({ id: 'c' }))).toBeUndefined();
  });
});

describe('sortByUrgency', () => {
  it('orders by state, then earliest deadline, then most recent update', () => {
    const sorted = sortByUrgency([
      session({ id: 'idle', status: 'idle', updatedAt: NOW }),
      session({ id: 'done', status: 'done' }),
      session({ id: 'working-old', status: 'working', updatedAt: NOW - 10 }),
      session({ id: 'working-new', status: 'working', updatedAt: NOW }),
      session({ id: 'error', status: 'error' }),
      session({ id: 'question', question: question(NOW + 1) }),
      session({ id: 'ok-late', approval: approval(NOW + 100) }),
      session({ id: 'ok-soon', approval: approval(NOW + 1) }),
    ]);
    expect(sorted.map((s) => s.id)).toEqual([
      'ok-soon',
      'ok-late',
      'question',
      'error',
      'working-new',
      'working-old',
      'done',
      'idle',
    ]);
  });

  it('does not mutate its input', () => {
    const input = [session({ id: 'a', status: 'idle' }), session({ id: 'b', status: 'error' })];
    sortByUrgency(input);
    expect(input.map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('waitingCount', () => {
  it('counts sessions with an approval or a question', () => {
    expect(waitingCount(fixtureInbox(NOW).sessions)).toBe(2);
  });
});

describe('fixtureInbox', () => {
  it('covers every state and keeps the history newest first', () => {
    const inbox = fixtureInbox(NOW);
    expect(new Set(inbox.sessions.map(stateOf))).toEqual(
      new Set(['needs-ok', 'question', 'error', 'working', 'done', 'idle']),
    );
    const times = inbox.history.map((entry) => entry.at);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});
