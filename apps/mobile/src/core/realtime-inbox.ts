import { revealHidden, toolInfo } from '@remote-control/protocol';
import type { Session } from '@remote-control/protocol';
import type {
  ApprovalView,
  MachineView,
  QuestionView,
  RealtimeState,
  RequestView,
} from '@remote-control/phone-core/realtime/realtime-store';

import type { AgentSession, PendingApproval, PendingQuestion, SessionStatus } from './model';

/** What the screens list for a session the agent has not described yet. */
const UNNAMED = 'Claude Code session';

/**
 * Text an agent or a repository supplies, with every hidden character shown as a marker
 * (V3-S03c): the inbox, history and widget snapshot all read these fields, and the widget
 * renders on the Lock Screen where no card-level reveal applies.
 */
const shown = (text: string): string => revealHidden(text).text;

function statusOf(state: Session['state'] | undefined): SessionStatus {
  if (state === 'idle') return 'idle';
  if (state === 'ended') return 'done';
  return 'working';
}

function approvalOf(view: ApprovalView): PendingApproval {
  const { request } = view;
  // The label comes from the tool name, never from the request's own label (V3-S03c).
  const tool = toolInfo(request.toolName);
  return {
    requestId: request.id,
    toolLabel: shown(tool.label),
    toolKind: tool.kind,
    detail: request.content,
    cwd: request.project ?? '',
    expiresAt: view.deadline,
    canAlways: request.alwaysSupported,
  };
}

function questionOf(view: QuestionView): PendingQuestion {
  const [first] = view.request.questions;
  return {
    requestId: view.request.id,
    header: first?.header ?? 'Question',
    prompt: first?.text ?? '',
    options: first?.options ?? [],
    expiresAt: view.deadline,
  };
}

function sessionOf(
  machine: MachineView,
  id: string,
  session: Session | undefined,
  pending: readonly RequestView[],
  now: number,
): AgentSession {
  const approval = pending.find((view): view is ApprovalView => view.kind !== 'question');
  const question = pending.find((view): view is QuestionView => view.kind === 'question');
  const project = pending.find((view) => view.request.project !== undefined)?.request.project;
  const lastTurn = session?.lastAnswer ?? session?.lastPrompt ?? undefined;
  return {
    id,
    machine: shown(machine.machine?.name ?? machine.name),
    project: shown(project ?? session?.name ?? machine.machine?.name ?? machine.name),
    title: shown(session?.statusText || session?.lastPrompt || UNNAMED),
    status: statusOf(session?.state),
    updatedAt: now,
    ...(approval && { approval: approvalOf(approval) }),
    ...(question && { question: questionOf(question) }),
    ...(lastTurn !== undefined && { lastTurn }),
  };
}

/**
 * The app's sessions from the shared phone core's live state (M4-03): every session of
 * every paired computer's latest snapshot, plus any session that only has a pending
 * request so far. The oldest pending approval and question of a session are shown.
 */
export function sessionsFromRealtime(state: RealtimeState, now: number): AgentSession[] {
  const pending = Object.values(state.requests)
    .filter((view) => view.status === 'pending')
    .sort((a, b) => a.deadline - b.deadline);
  const sessions: AgentSession[] = [];
  for (const machine of Object.values(state.machines)) {
    const mine = pending.filter((view) => view.machineId === machine.deviceId);
    const ids = new Set([
      ...machine.sessions.map((session) => session.id),
      ...mine.map((view) => view.request.sessionId),
    ]);
    for (const id of ids) {
      const session = machine.sessions.find((candidate) => candidate.id === id);
      const waiting = mine.filter((view) => view.request.sessionId === id);
      sessions.push(sessionOf(machine, id, session, waiting, now));
    }
  }
  return sessions;
}

/** The pending request a session shows, to send the decision on (`undefined`: none). */
export function pendingRequestFor(
  state: RealtimeState,
  requestId: string,
): RequestView | undefined {
  const view = state.requests[requestId];
  return view?.status === 'pending' ? view : undefined;
}
