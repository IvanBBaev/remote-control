import type { AgentSession, AgentState } from './model';

/** Most urgent first; the agents list and the Live Activity count follow this order. */
export const URGENCY: readonly AgentState[] = [
  'needs-ok',
  'question',
  'error',
  'working',
  'done',
  'idle',
];

export function stateOf(session: AgentSession): AgentState {
  if (session.approval) return 'needs-ok';
  if (session.question) return 'question';
  return session.status;
}

/** The deadline of whatever the session waits on, or `undefined` when it waits on nothing. */
export function deadlineOf(session: AgentSession): number | undefined {
  return session.approval?.expiresAt ?? session.question?.expiresAt;
}

/**
 * Urgency order, then the earliest deadline among waiting sessions, then the most recently
 * updated. Returns a new array.
 */
export function sortByUrgency(sessions: readonly AgentSession[]): AgentSession[] {
  return [...sessions].sort((a, b) => {
    const rank = URGENCY.indexOf(stateOf(a)) - URGENCY.indexOf(stateOf(b));
    if (rank !== 0) return rank;
    const deadlineA = deadlineOf(a) ?? Number.POSITIVE_INFINITY;
    const deadlineB = deadlineOf(b) ?? Number.POSITIVE_INFINITY;
    if (deadlineA !== deadlineB) return deadlineA - deadlineB;
    return b.updatedAt - a.updatedAt;
  });
}

/** Sessions waiting on the user: an approval or a question. */
export function waitingCount(sessions: readonly AgentSession[]): number {
  return sessions.filter((session) => session.approval ?? session.question).length;
}
