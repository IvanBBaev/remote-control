import type { Capabilities } from '@remote-control/protocol';

import type { PendingRequest } from '../core/pending-store.js';

/** The coding agents an adapter can stand for (D12); Claude Code is the only one until M2. */
export type AgentAdapterId = 'claude-code' | 'codex' | 'gemini';

/** A permission prompt the agent is about to show, in vendor-neutral form. */
export interface PermissionEvent {
  readonly kind: 'permission';
  readonly sessionId: string;
  readonly cwd: string;
  readonly toolName: string;
  /** The tool input as received; never rewritten (02 W8). */
  readonly toolInput: unknown;
  /** The vendor's "always allow" suggestions, verbatim (D24 uses them in M1). */
  readonly suggestions: readonly unknown[];
  /** The vendor offered at least one "always" rule for this request. */
  readonly alwaysSupported: boolean;
}

/** One option of an `AskUserQuestion` question, as Claude Code sends it. */
export interface QuestionEventOption {
  readonly label: string;
  readonly description?: string;
}

/** One `AskUserQuestion` question in vendor-neutral form (04 §2.3). */
export interface QuestionEventItem {
  readonly question: string;
  readonly header?: string;
  readonly options: readonly QuestionEventOption[];
  readonly multiSelect: boolean;
}

/** The coding agent asks the user 1–4 multiple-choice questions (M1-01, 04 §2.3). */
export interface QuestionEvent {
  readonly kind: 'question';
  readonly sessionId: string;
  readonly cwd: string;
  readonly questions: readonly QuestionEventItem[];
}

/** A session starting or ending; seeds the session registry (04 §5.3). */
export interface SessionEvent {
  readonly kind: 'session';
  readonly phase: 'start' | 'end';
  readonly sessionId: string;
  readonly cwd: string;
  readonly transcriptPath?: string;
  /** `SessionStart.source` (`startup`, `resume`, …) or `SessionEnd.reason`. */
  readonly detail?: string;
}

/** A hook event in vendor-neutral form (04 §5.7); feed kinds arrive with 04 W8. */
export type HookEvent = PermissionEvent | QuestionEvent | SessionEvent;

/**
 * The answers to a question request, already checked against the pending questions:
 * question text → the picked labels and/or the "Other" text, joined with ", " (04 §2.3).
 */
export interface QuestionAnswers {
  readonly answers: Readonly<Record<string, string>>;
  /** Optional free text for the whole question set. */
  readonly response?: string;
}

/**
 * The phone's decision as the adapter sees it. `handoff` = no decision: the vendor's own
 * prompt appears in the terminal (D10). `answer` answers a question request (M1-01).
 */
export interface AdapterDecision {
  readonly behavior: 'allow' | 'deny' | 'handoff' | 'answer';
  /** For `deny`: the reason shown to the coding agent. */
  readonly message?: string;
  /** For `answer`: the checked answers. */
  readonly answer?: QuestionAnswers;
}

/**
 * The boundary between the agent core and one coding agent (D12, 04 §5.7). This is the
 * M0 subset; `detect`, `listSessions`, `start` and `followUp` join with the session
 * registry and launcher work packages, and the hooks installer stays its own module.
 */
export interface AgentAdapter {
  readonly id: AgentAdapterId;
  /** What the phone may offer for this agent (D12). */
  readonly capabilities: Capabilities;
  /** Vendor hook JSON → common event; `null` for events this adapter does not map yet. */
  onHook(raw: unknown): HookEvent | null;
  /** Common decision → the vendor hook output that `hook.js` prints verbatim. */
  decide(request: PendingRequest, decision: AdapterDecision): Readonly<Record<string, unknown>>;
}
