import { describe, expect, it } from 'vitest';

import { fixtureInbox } from './fixtures';
import { decide, expire, HISTORY_LIMIT, type Inbox } from './inbox';

const NOW = 1_800_000_000_000;

function find(inbox: Inbox, id: string) {
  const session = inbox.sessions.find((s) => s.id === id);
  if (!session) throw new Error(`no session ${id}`);
  return session;
}

describe('decide', () => {
  it.each(['allow', 'always', 'deny'] as const)(
    '%s clears the approval and logs the command',
    (kind) => {
      const next = decide(fixtureInbox(NOW), { sessionId: 's-api', kind }, NOW + 1);
      const session = find(next, 's-api');
      expect(session.approval).toBeUndefined();
      expect(session.status).toBe('working');
      expect(session.updatedAt).toBe(NOW + 1);
      expect(next.history[0]).toMatchObject({
        outcome: kind,
        sessionId: 's-api',
        label: 'Run a command',
        detail: 'pnpm vitest run src/invoice --coverage',
        at: NOW + 1,
      });
    },
  );

  it('answers a question with the chosen option', () => {
    const next = decide(
      fixtureInbox(NOW),
      { sessionId: 's-web', kind: 'answer', payload: ' WebP ' },
      NOW,
    );
    expect(find(next, 's-web').question).toBeUndefined();
    expect(next.history[0]).toMatchObject({
      outcome: 'answer',
      label: 'Image format',
      detail: 'WebP',
    });
  });

  it('sends an instruction to a session that waits on nothing', () => {
    const next = decide(
      fixtureInbox(NOW),
      { sessionId: 's-infra', kind: 'instruct', payload: 'Stop the old container first' },
      NOW,
    );
    expect(find(next, 's-infra').status).toBe('working');
    expect(next.history[0]).toMatchObject({
      label: 'Instruction',
      detail: 'Stop the old container first',
    });
  });

  it.each([
    ['an unknown session', { sessionId: 'nope', kind: 'allow' as const }],
    ['an allow with no approval', { sessionId: 's-web', kind: 'allow' as const }],
    ['an answer with no question', { sessionId: 's-api', kind: 'answer' as const, payload: 'x' }],
    ['an empty answer', { sessionId: 's-web', kind: 'answer' as const, payload: '  ' }],
    ['an empty instruction', { sessionId: 's-infra', kind: 'instruct' as const }],
    [
      'an instruction while an approval waits',
      { sessionId: 's-api', kind: 'instruct' as const, payload: 'go' },
    ],
    [
      'an instruction while a question waits',
      { sessionId: 's-web', kind: 'instruct' as const, payload: 'go' },
    ],
  ])('ignores %s', (_name, input) => {
    const inbox = fixtureInbox(NOW);
    expect(decide(inbox, input, NOW)).toBe(inbox);
  });

  it('keeps the history bounded', () => {
    let inbox = fixtureInbox(NOW);
    for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) {
      inbox = decide(
        inbox,
        { sessionId: 's-mobile', kind: 'instruct', payload: `step ${i}` },
        NOW + i,
      );
    }
    expect(inbox.history).toHaveLength(HISTORY_LIMIT);
    expect(inbox.history[0]?.detail).toBe(`step ${HISTORY_LIMIT + 4}`);
  });
});

describe('expire', () => {
  it('leaves everything in place before a deadline', () => {
    const inbox = fixtureInbox(NOW);
    expect(expire(inbox, NOW)).toBe(inbox);
  });

  it('drops approvals and questions past their deadline and logs them', () => {
    const later = NOW + 60 * 60_000;
    const next = expire(fixtureInbox(NOW), later);
    expect(find(next, 's-api').approval).toBeUndefined();
    expect(find(next, 's-api').status).toBe('working');
    expect(find(next, 's-web').question).toBeUndefined();
    expect(next.history.slice(0, 2)).toEqual([
      expect.objectContaining({ outcome: 'expired', sessionId: 's-web', label: 'Image format' }),
      expect.objectContaining({ outcome: 'expired', sessionId: 's-api', label: 'Run a command' }),
    ]);
  });
});
