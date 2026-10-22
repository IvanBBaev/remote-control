import type { AgentSession, AgentState } from './model';
import { deadlineOf, sortByUrgency, stateOf } from './urgency';

/** The App Group shared by the app and its WidgetKit extension (ADR 0017). */
export const APP_GROUP = 'group.dev.ivanbaev.remotecontrol';

/** The `UserDefaults` key in `APP_GROUP` that holds the JSON snapshot. */
export const SNAPSHOT_KEY = 'widgetSnapshot';

/** Rows the medium widget can show; the snapshot never carries more. */
export const WIDGET_ROWS = 3;

/** Opens the agents list. */
export const AGENTS_URL = 'remotecontrol://';

/**
 * One session as a widget shows it. Widgets render on the Lock Screen without Face ID,
 * so a row carries no command, path, question text or last turn: the same level as a
 * push summary (D5), never more.
 */
export interface WidgetRow {
  readonly id: string;
  readonly machine: string;
  readonly project: string;
  readonly state: AgentState;
  /** Plain words: the tool label for an approval ("Run a command"), else the state. */
  readonly label: string;
  /** Unix milliseconds; only while the session waits on the user. */
  readonly expiresAt?: number;
  /** Deep link to the session screen. */
  readonly url: string;
}

/** What the app writes to the App Group for the widgets and the Control Center control. */
export interface WidgetSnapshot {
  readonly version: 1;
  /** Unix milliseconds when the app wrote it. */
  readonly writtenAt: number;
  /** The rows are sample data, not a live relay. */
  readonly sample: boolean;
  /** Sessions waiting on an approval or an answer. */
  readonly waiting: number;
  readonly needsOk: number;
  readonly questions: number;
  readonly errors: number;
  readonly working: number;
  /** The earliest deadline among waiting sessions. */
  readonly nextExpiry?: number;
  /** Most urgent first, at most `WIDGET_ROWS`, idle sessions left out. */
  readonly rows: readonly WidgetRow[];
  /** Where a tap on the whole widget goes: the most urgent waiting session, else the list. */
  readonly url: string;
}

const STATE_LABELS: Readonly<Record<AgentState, string>> = {
  'needs-ok': 'Needs your OK',
  question: 'Has a question',
  error: 'Stopped on an error',
  working: 'Working',
  done: 'Done',
  idle: 'Idle',
};

export function sessionUrl(id: string): string {
  return `remotecontrol://session/${encodeURIComponent(id)}`;
}

function rowOf(session: AgentSession): WidgetRow {
  const state = stateOf(session);
  const expiresAt = deadlineOf(session);
  return {
    id: session.id,
    machine: session.machine,
    project: session.project,
    state,
    label: session.approval?.toolLabel ?? STATE_LABELS[state],
    ...(expiresAt === undefined ? {} : { expiresAt }),
    url: sessionUrl(session.id),
  };
}

/** The agent has already fallen back to the terminal for a request past its deadline (D10). */
function withoutExpired(session: AgentSession, now: number): AgentSession {
  const deadline = deadlineOf(session);
  if (deadline === undefined || deadline > now) return session;
  const { approval: _approval, question: _question, ...rest } = session;
  return rest;
}

/** Builds the snapshot the widgets read; requests past their deadline no longer count as waiting. */
export function widgetSnapshot(
  sessions: readonly AgentSession[],
  now: number,
  sample: boolean,
): WidgetSnapshot {
  const rows = sortByUrgency(sessions.map((session) => withoutExpired(session, now)))
    .filter((session) => stateOf(session) !== 'idle')
    .map(rowOf);
  const count = (state: AgentState) => rows.filter((row) => row.state === state).length;
  const deadlines = rows.flatMap((row) => (row.expiresAt === undefined ? [] : [row.expiresAt]));
  const first = rows[0];
  const needsOk = count('needs-ok');
  const questions = count('question');
  return {
    version: 1,
    writtenAt: now,
    sample,
    waiting: needsOk + questions,
    needsOk,
    questions,
    errors: count('error'),
    working: count('working'),
    ...(deadlines.length === 0 ? {} : { nextExpiry: Math.min(...deadlines) }),
    rows: rows.slice(0, WIDGET_ROWS),
    url: first?.expiresAt === undefined ? AGENTS_URL : first.url,
  };
}

/**
 * The snapshot without `writtenAt`, for deciding whether the widgets need a reload: a
 * store update that changes nothing they show must not spend the reload budget.
 */
export function snapshotKey(snapshot: WidgetSnapshot): string {
  const { writtenAt: _writtenAt, ...rest } = snapshot;
  return JSON.stringify(rest);
}

/**
 * The `UserDefaults` key in `APP_GROUP` where the Control Center control leaves the deep link
 * it wants opened, as `{"url","at"}` JSON: the control cannot hand the app a URL directly.
 */
export const PENDING_LINK_KEY = 'pendingLink';

/** A pending link older than this was left behind by a tap the app never saw; ignore it. */
export const PENDING_LINK_TTL_MS = 30_000;

/** The deep link a fresh, well-formed pending-link record names, else `undefined`. */
export function parsePendingLink(raw: string | null, now: number): string | undefined {
  if (raw === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { url, at } = value as { url?: unknown; at?: unknown };
  if (typeof url !== 'string' || !url.startsWith(AGENTS_URL)) return undefined;
  if (typeof at !== 'number' || Math.abs(now - at) > PENDING_LINK_TTL_MS) return undefined;
  return url;
}
