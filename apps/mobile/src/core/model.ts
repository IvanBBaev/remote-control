import type { DecisionKind, ToolKind } from '@remote-control/protocol';

/**
 * What a session needs from the user, most urgent first in `URGENCY` (ADR 0017): an
 * approval, a question, an error, then the quiet states.
 */
export type AgentState = 'needs-ok' | 'question' | 'error' | 'working' | 'done' | 'idle';

/** The states a session has on its own; `needs-ok` and `question` come from what is pending. */
export type SessionStatus = Extract<AgentState, 'error' | 'working' | 'done' | 'idle'>;

export interface PendingApproval {
  readonly requestId: string;
  /** Plain-word label ("Run a command"), never the raw tool name (01 W4). */
  readonly toolLabel: string;
  readonly toolKind: ToolKind;
  /** The command, file path or URL the tool acts on. */
  readonly detail: string;
  readonly cwd: string;
  /** Unix milliseconds. */
  readonly expiresAt: number;
  /** The agent offered "Always allow" for this request. */
  readonly canAlways: boolean;
}

export interface QuestionOption {
  readonly label: string;
  readonly description?: string;
}

export interface PendingQuestion {
  readonly requestId: string;
  readonly header: string;
  readonly prompt: string;
  readonly options: readonly QuestionOption[];
  /** Unix milliseconds. */
  readonly expiresAt: number;
}

export interface AgentSession {
  readonly id: string;
  /** The machine's label ("MacBook Pro"). */
  readonly machine: string;
  readonly project: string;
  readonly branch?: string;
  readonly title: string;
  readonly status: SessionStatus;
  /** Unix milliseconds. */
  readonly updatedAt: number;
  readonly approval?: PendingApproval;
  readonly question?: PendingQuestion;
  /** The agent's last message, as plain text. */
  readonly lastTurn?: string;
  readonly error?: string;
}

/** What the phone can decide from the app; the protocol's kinds minus the M1 extras. */
export type PhoneDecision = Extract<
  DecisionKind,
  'allow' | 'always' | 'deny' | 'answer' | 'instruct'
>;

export type HistoryOutcome = PhoneDecision | 'expired';

export interface HistoryEntry {
  readonly id: string;
  readonly sessionId: string;
  readonly machine: string;
  readonly project: string;
  readonly outcome: HistoryOutcome;
  /** What was decided on ("Run a command", the question header, "Instruction"). */
  readonly label: string;
  /** The command, the chosen answer or the instruction text. */
  readonly detail: string;
  /** Unix milliseconds. */
  readonly at: number;
}
