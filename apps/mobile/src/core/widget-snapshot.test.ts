import { describe, expect, it } from 'vitest';

import { fixtureInbox } from './fixtures';
import type { AgentSession } from './model';
import {
  AGENTS_URL,
  parsePendingLink,
  PENDING_LINK_TTL_MS,
  sessionUrl,
  snapshotKey,
  WIDGET_ROWS,
  widgetSnapshot,
} from './widget-snapshot';

const NOW = 1_800_000_000_000;

function session(overrides: Partial<AgentSession> & Pick<AgentSession, 'id'>): AgentSession {
  return {
    machine: 'MacBook Pro',
    project: 'p',
    title: 'secret title',
    status: 'idle',
    updatedAt: NOW,
    ...overrides,
  };
}

const approval = (expiresAt: number) => ({
  requestId: 'r',
  toolLabel: 'Run a command',
  toolKind: 'command' as const,
  detail: 'rm -rf ~/secret',
  cwd: '~/private/path',
  expiresAt,
  canAlways: false,
});

const question = (expiresAt: number) => ({
  requestId: 'q',
  header: 'Secret header',
  prompt: 'Which secret?',
  options: [{ label: 'secret option' }],
  expiresAt,
});

describe('widgetSnapshot', () => {
  it('orders rows by urgency, counts states and links the most urgent waiting session', () => {
    const snapshot = widgetSnapshot(
      [
        session({ id: 'idle' }),
        session({ id: 'work', status: 'working' }),
        session({ id: 'ask', question: question(NOW + 90_000) }),
        session({ id: 'err', status: 'error', error: 'boom' }),
        session({ id: 'ok', approval: approval(NOW + 60_000) }),
      ],
      NOW,
      false,
    );
    expect(snapshot).toMatchObject({
      version: 1,
      writtenAt: NOW,
      sample: false,
      waiting: 2,
      needsOk: 1,
      questions: 1,
      errors: 1,
      working: 1,
      nextExpiry: NOW + 60_000,
      url: sessionUrl('ok'),
    });
    expect(snapshot.rows.map((row) => [row.id, row.state, row.label])).toEqual([
      ['ok', 'needs-ok', 'Run a command'],
      ['ask', 'question', 'Has a question'],
      ['err', 'error', 'Stopped on an error'],
    ]);
    expect(snapshot.rows).toHaveLength(WIDGET_ROWS);
    expect(snapshot.rows[0]).toEqual({
      id: 'ok',
      machine: 'MacBook Pro',
      project: 'p',
      state: 'needs-ok',
      label: 'Run a command',
      expiresAt: NOW + 60_000,
      url: 'remotecontrol://session/ok',
    });
  });

  it('never carries a command, path, question text, title or error text', () => {
    const json = JSON.stringify(
      widgetSnapshot(
        [
          session({ id: 'a', approval: approval(NOW + 1), lastTurn: 'secret turn' }),
          session({ id: 'b', question: question(NOW + 1) }),
          session({ id: 'c', status: 'error', error: 'secret error' }),
        ],
        NOW,
        false,
      ),
    );
    expect(json).not.toMatch(/secret|rm -rf|private/);
  });

  it('opens the agents list when nothing waits, and leaves idle sessions out', () => {
    const snapshot = widgetSnapshot(
      [session({ id: 'done', status: 'done' }), session({ id: 'idle' })],
      NOW,
      true,
    );
    expect(snapshot).toMatchObject({ waiting: 0, sample: true, url: AGENTS_URL });
    expect(snapshot).not.toHaveProperty('nextExpiry');
    expect(snapshot.rows.map((row) => [row.id, row.label])).toEqual([['done', 'Done']]);
    expect(snapshot.rows[0]).not.toHaveProperty('expiresAt');
  });

  it('stops counting a request at its deadline', () => {
    const snapshot = widgetSnapshot(
      [session({ id: 'late', status: 'working', approval: approval(NOW) })],
      NOW,
      false,
    );
    expect(snapshot).toMatchObject({ waiting: 0, working: 1, url: AGENTS_URL });
    expect(snapshot.rows[0]?.label).toBe('Working');
  });

  it('is empty for no sessions', () => {
    expect(widgetSnapshot([], NOW, false)).toMatchObject({ rows: [], waiting: 0, url: AGENTS_URL });
  });

  it('encodes the session id in the deep link', () => {
    expect(sessionUrl('a b/c')).toBe('remotecontrol://session/a%20b%2Fc');
  });

  it('renders the sample inbox with its waiting sessions first', () => {
    const { sessions } = fixtureInbox(NOW);
    const snapshot = widgetSnapshot(sessions, NOW, true);
    expect(snapshot.waiting).toBeGreaterThan(0);
    expect(snapshot.rows[0]?.state).toBe('needs-ok');
  });
});

describe('snapshotKey', () => {
  it('ignores the write time and changes with what the widgets show', () => {
    const sessions = [session({ id: 'ok', approval: approval(NOW + 60_000) })];
    const a = widgetSnapshot(sessions, NOW, false);
    const b = widgetSnapshot(sessions, NOW + 1_000, false);
    expect(snapshotKey(a)).toBe(snapshotKey(b));
    expect(snapshotKey(widgetSnapshot([], NOW, false))).not.toBe(snapshotKey(a));
  });
});

describe('parsePendingLink', () => {
  const record = (url: unknown, at: unknown) => JSON.stringify({ url, at });

  it('returns a fresh deep link', () => {
    expect(parsePendingLink(record(sessionUrl('ok'), NOW - 1_000), NOW)).toBe(
      'remotecontrol://session/ok',
    );
    expect(parsePendingLink(record(AGENTS_URL, NOW), NOW)).toBe(AGENTS_URL);
  });

  it('ignores a missing, malformed, foreign or stale record', () => {
    expect(parsePendingLink(null, NOW)).toBeUndefined();
    expect(parsePendingLink('not json', NOW)).toBeUndefined();
    expect(parsePendingLink('null', NOW)).toBeUndefined();
    expect(parsePendingLink('"remotecontrol://"', NOW)).toBeUndefined();
    expect(parsePendingLink(record('https://example.com', NOW), NOW)).toBeUndefined();
    expect(parsePendingLink(record(42, NOW), NOW)).toBeUndefined();
    expect(parsePendingLink(record(AGENTS_URL, 'now'), NOW)).toBeUndefined();
    expect(
      parsePendingLink(record(AGENTS_URL, NOW - PENDING_LINK_TTL_MS - 1), NOW),
    ).toBeUndefined();
  });
});
