import type { AgentSession, HistoryEntry, PhoneDecision } from './model';

export interface Inbox {
  readonly sessions: readonly AgentSession[];
  /** Newest first. */
  readonly history: readonly HistoryEntry[];
}

export interface DecisionInput {
  readonly sessionId: string;
  readonly kind: PhoneDecision;
  /** The chosen answer for `answer`, the text for `instruct`; ignored otherwise. */
  readonly payload?: string;
}

/** Most entries the local history keeps. */
export const HISTORY_LIMIT = 200;

/** Suggested instructions under the composer (Coucou's quick-reply chips). */
export const QUICK_REPLIES: readonly string[] = [
  'Continue',
  'Run the tests',
  'Explain the change',
  'Stop here',
];

function record(inbox: Inbox, sessions: AgentSession[], entry: HistoryEntry): Inbox {
  return { sessions, history: [entry, ...inbox.history].slice(0, HISTORY_LIMIT) };
}

function replace(
  sessions: readonly AgentSession[],
  id: string,
  next: AgentSession,
): AgentSession[] {
  return sessions.map((session) => (session.id === id ? next : session));
}

function withoutPending(session: AgentSession, now: number): AgentSession {
  const { approval: _approval, question: _question, ...rest } = session;
  return { ...rest, status: 'working', updatedAt: now };
}

/**
 * Applies a decision taken on the phone. The session stops waiting and goes back to
 * `working`; the decision lands in the history. A decision on nothing pending, an answer
 * without a choice or an empty instruction leaves the inbox unchanged.
 */
export function decide(inbox: Inbox, input: DecisionInput, now: number): Inbox {
  const session = inbox.sessions.find((candidate) => candidate.id === input.sessionId);
  if (!session) return inbox;
  const base = {
    id: `${session.id}:${now}`,
    sessionId: session.id,
    machine: session.machine,
    project: session.project,
    outcome: input.kind,
    at: now,
  };
  switch (input.kind) {
    case 'allow':
    case 'always':
    case 'deny': {
      const { approval } = session;
      if (!approval) return inbox;
      return record(inbox, replace(inbox.sessions, session.id, withoutPending(session, now)), {
        ...base,
        label: approval.toolLabel,
        detail: approval.detail,
      });
    }
    case 'answer': {
      const { question } = session;
      const answer = input.payload?.trim();
      if (!question || !answer) return inbox;
      return record(inbox, replace(inbox.sessions, session.id, withoutPending(session, now)), {
        ...base,
        label: question.header,
        detail: answer,
      });
    }
    case 'instruct': {
      const text = input.payload?.trim();
      if (!text || session.approval || session.question) return inbox;
      return record(inbox, replace(inbox.sessions, session.id, withoutPending(session, now)), {
        ...base,
        label: 'Instruction',
        detail: text,
      });
    }
  }
}

/**
 * Drops every approval and question past its deadline: the agent has already fallen back
 * to the terminal (D10). Each one is logged as `expired`.
 */
export function expire(inbox: Inbox, now: number): Inbox {
  let next = inbox;
  for (const session of inbox.sessions) {
    const { approval, question, ...rest } = session;
    const pending = approval
      ? { label: approval.toolLabel, detail: approval.detail, expiresAt: approval.expiresAt }
      : question && {
          label: question.header,
          detail: question.prompt,
          expiresAt: question.expiresAt,
        };
    if (!pending || pending.expiresAt > now) continue;
    const { label, detail } = pending;
    next = record(next, replace(next.sessions, session.id, { ...rest, updatedAt: now }), {
      id: `${session.id}:${now}`,
      sessionId: session.id,
      machine: session.machine,
      project: session.project,
      outcome: 'expired',
      label,
      detail,
      at: now,
    });
  }
  return next;
}
