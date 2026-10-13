import { z } from 'zod';

import type { AdapterDecision } from '../ports/agent-adapter.js';
import type { HookInput } from './hook-dispatcher.js';

/**
 * Local usage counters (M1-11, 01 W13): kept on this computer only, never sent anywhere —
 * project names are plaintext and the relay sees metadata only (I3).
 */

/** What is counted per project. */
export const STAT_FIELDS = ['approvals', 'denials', 'sessionsStarted'] as const;
export type StatField = (typeof STAT_FIELDS)[number];

/** The key for activity whose working directory is unknown. */
export const NO_PROJECT = '(no folder)';

const Count = z.int().nonnegative();

export const ProjectStats = z.strictObject({
  approvals: Count,
  denials: Count,
  sessionsStarted: Count,
});
export type ProjectStats = z.infer<typeof ProjectStats>;

/** `stats.json` (0600, data dir): counters per project folder name. */
export const StatsFile = z.strictObject({
  version: z.literal(1),
  projects: z.record(z.string().min(1).max(128), ProjectStats),
});
export type StatsFile = z.infer<typeof StatsFile>;

export function emptyStats(): StatsFile {
  return { version: 1, projects: {} };
}

const ZERO: ProjectStats = { approvals: 0, denials: 0, sessionsStarted: 0 };

/** `stats` with one more `field` for `project` (`NO_PROJECT` when unknown). */
export function recordStat(
  stats: StatsFile,
  project: string | undefined,
  field: StatField,
): StatsFile {
  const key = project ?? NO_PROJECT;
  const current = Object.hasOwn(stats.projects, key) ? stats.projects[key]! : ZERO;
  return {
    ...stats,
    projects: { ...stats.projects, [key]: { ...current, [field]: current[field] + 1 } },
  };
}

/** The file's counters; `undefined` when the text is not a valid stats file. */
export function parseStats(text: string): StatsFile | undefined {
  try {
    const parsed = StatsFile.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Totals over every project. */
export function totalStats(stats: StatsFile): ProjectStats {
  return Object.values(stats.projects).reduce<ProjectStats>(
    (sum, project) => ({
      approvals: sum.approvals + project.approvals,
      denials: sum.denials + project.denials,
      sessionsStarted: sum.sessionsStarted + project.sessionsStarted,
    }),
    ZERO,
  );
}

const plural = (count: number, one: string, many: string): string =>
  `${String(count)} ${count === 1 ? one : many}`;

/** `3 approved, 1 denied, 2 sessions`. */
export function statsSummary(stats: ProjectStats): string {
  return [
    `${String(stats.approvals)} approved`,
    `${String(stats.denials)} denied`,
    plural(stats.sessionsStarted, 'session', 'sessions'),
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
