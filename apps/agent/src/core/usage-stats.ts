import { MAX_HISTORY_PROJECTS, type ProjectHistory } from '@remote-control/protocol';
import { z } from 'zod';

import type { AdapterDecision } from '../ports/agent-adapter.js';
import type { HookInput } from './hook-dispatcher.js';

/**
 * Local usage counters (M1-11, M2-06; 01 W13): kept on this computer, never sent to the
 * relay — project names are plaintext, so they reach a phone only inside a session (I3).
 */

/** What is counted per project. */
export const STAT_FIELDS = [
  'approvals',
  'denials',
  'sessionsStarted',
  'toolCalls',
  'activeMs',
] as const;
export type StatField = (typeof STAT_FIELDS)[number];

/** Amounts to add per field; at least one field. */
export type StatDelta = Partial<Record<StatField, number>>;

/** The key for activity whose working directory is unknown. */
export const NO_PROJECT = '(no folder)';

const Count = z.int().nonnegative();
const ProjectName = z.string().min(1).max(128);

export const ProjectStats = z.strictObject({
  approvals: Count,
  denials: Count,
  sessionsStarted: Count,
  toolCalls: Count,
  /** Turn time: from the prompt to the agent's stop. */
  activeMs: Count,
  /** Epoch ms of the latest counted activity; `null` for counters from version 1. */
  lastActiveAt: Count.nullable(),
});
export type ProjectStats = z.infer<typeof ProjectStats>;

/** `stats.json` (0600, data dir): counters per project folder name. */
export const StatsFile = z.strictObject({
  version: z.literal(2),
  projects: z.record(ProjectName, ProjectStats),
});
export type StatsFile = z.infer<typeof StatsFile>;

/** The M1-11 file: approvals, denials and sessions only. */
const StatsFileV1 = z.strictObject({
  version: z.literal(1),
  projects: z.record(
    ProjectName,
    z.strictObject({ approvals: Count, denials: Count, sessionsStarted: Count }),
  ),
});

export function emptyStats(): StatsFile {
  return { version: 2, projects: {} };
}

const ZERO: ProjectStats = {
  approvals: 0,
  denials: 0,
  sessionsStarted: 0,
  toolCalls: 0,
  activeMs: 0,
  lastActiveAt: null,
};

/** `stats` with `delta` added to `project` (`NO_PROJECT` when unknown), active at `now`. */
export function recordStats(
  stats: StatsFile,
  project: string | undefined,
  delta: StatDelta,
  now: number,
): StatsFile {
  const key = project ?? NO_PROJECT;
  const next = { ...(Object.hasOwn(stats.projects, key) ? stats.projects[key]! : ZERO) };
  for (const field of STAT_FIELDS) next[field] += delta[field] ?? 0;
  next.lastActiveAt = Math.max(now, next.lastActiveAt ?? 0);
  return { ...stats, projects: { ...stats.projects, [key]: next } };
}

/**
 * The file's counters, upgrading a version 1 file; `undefined` when the text is not a
 * valid stats file.
 */
export function parseStats(text: string): StatsFile | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const current = StatsFile.safeParse(value);
  if (current.success) return current.data;
  const v1 = StatsFileV1.safeParse(value);
  if (!v1.success) return undefined;
  return {
    version: 2,
    projects: Object.fromEntries(
      Object.entries(v1.data.projects).map(([name, counts]) => [name, { ...ZERO, ...counts }]),
    ),
  };
}

/** Totals over every project; `lastActiveAt` is the latest of them. */
export function totalStats(stats: StatsFile): ProjectStats {
  return Object.values(stats.projects).reduce<ProjectStats>(
    (sum, project) => ({
      approvals: sum.approvals + project.approvals,
      denials: sum.denials + project.denials,
      sessionsStarted: sum.sessionsStarted + project.sessionsStarted,
      toolCalls: sum.toolCalls + project.toolCalls,
      activeMs: sum.activeMs + project.activeMs,
      lastActiveAt:
        project.lastActiveAt === null
          ? sum.lastActiveAt
          : Math.max(project.lastActiveAt, sum.lastActiveAt ?? 0),
    }),
    ZERO,
  );
}

const plural = (count: number, one: string, many: string): string =>
  `${String(count)} ${count === 1 ? one : many}`;

/** `2 h 5 min`, `12 min`, `under a minute`. */
export function activeTimeText(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${String(rest)} min`;
  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
}

/** `3 approved, 1 denied, 2 sessions, 40 tool calls, 1 h 5 min active`. */
export function statsSummary(stats: ProjectStats): string {
  return [
    `${String(stats.approvals)} approved`,
    `${String(stats.denials)} denied`,
    plural(stats.sessionsStarted, 'session', 'sessions'),
    plural(stats.toolCalls, 'tool call', 'tool calls'),
    `${activeTimeText(stats.activeMs)} active`,
  ].join(', ');
}

/** `remotectl status` lines: the totals, then one indented line per project by name. */
export function formatStats(stats: StatsFile): string[] {
  const projects = Object.entries(stats.projects).sort(([a], [b]) => a.localeCompare(b));
  if (projects.length === 0) return ['(none yet)'];
  return [
    statsSummary(totalStats(stats)),
    ...projects.map(([name, project]) => `  ${name}  ${statsSummary(project)}`),
  ];
}

/** The phone's view of the counters: most recently active first, then by name. */
export function statsHistory(stats: StatsFile): ProjectHistory[] {
  return Object.entries(stats.projects)
    .sort(([a, x], [b, y]) => (y.lastActiveAt ?? -1) - (x.lastActiveAt ?? -1) || a.localeCompare(b))
    .slice(0, MAX_HISTORY_PROJECTS)
    .map(([project, counts]) => ({
      project,
      sessions: counts.sessionsStarted,
      toolCalls: counts.toolCalls,
      approvals: counts.approvals,
      denials: counts.denials,
      activeMs: counts.activeMs,
      lastActiveAt: counts.lastActiveAt,
    }));
}

/** A new Claude Code session (not a resume, clear or compact of an existing one). */
export function isSessionStart(input: HookInput): boolean {
  if (input.hook_event_name !== 'SessionStart') return false;
  const source = input['source'];
  return source === undefined || source === 'startup';
}

/** The counter a phone decision moves; a handoff counts as neither. */
export function decisionStat(behavior: AdapterDecision['behavior']): StatField | undefined {
  if (behavior === 'allow') return 'approvals';
  if (behavior === 'deny') return 'denials';
  return undefined;
}

/** How many sessions may have an open turn at once; the oldest is forgotten first. */
export const MAX_OPEN_TURNS = 1000;

/** Turns hook events into counter changes; open turns live in memory only. */
export interface ActivityTracker {
  /** What `input` adds to the counters, if anything. */
  observe(input: HookInput, now: number): StatDelta | undefined;
}

/**
 * New sessions, completed tool calls (`PostToolUse`) and turn time. A turn starts at
 * `UserPromptSubmit` and ends at `Stop` or `SessionEnd`; a turn the agent did not see
 * start (it was restarted meanwhile) adds no time.
 */
export function createActivityTracker(): ActivityTracker {
  const turns = new Map<string, number>();
  return {
    observe(input, now) {
      const session = input.session_id;
      switch (input.hook_event_name) {
        case 'SessionStart':
          return isSessionStart(input) ? { sessionsStarted: 1 } : undefined;
        case 'PostToolUse':
          return { toolCalls: 1 };
        case 'UserPromptSubmit':
          turns.delete(session);
          turns.set(session, now);
          if (turns.size > MAX_OPEN_TURNS) turns.delete(turns.keys().next().value!);
          return undefined;
        case 'Stop':
        case 'SessionEnd': {
          const start = turns.get(session);
          if (start === undefined) return undefined;
          turns.delete(session);
          return { activeMs: Math.max(0, now - start) };
        }
        default:
          return undefined;
      }
    },
  };
}
