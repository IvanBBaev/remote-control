import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand/vanilla';

import type { ProjectHistory } from '@remote-control/protocol';

import { ago } from './realtime-store.js';
import type { RealtimeStore, RequestView } from './realtime-store.js';

/**
 * Local usage counters on the phone (M1-11, 01 W13): kept in this browser only, never
 * sent anywhere — project names are plaintext and the relay sees metadata only (I1/I3).
 */

export interface UsageCounts {
  /** Allow decisions this phone sent and the computer accepted. */
  readonly approvals: number;
  /** Deny decisions this phone sent and the computer accepted. */
  readonly denials: number;
  /** Distinct agent sessions that asked this phone. */
  readonly sessions: number;
}

export type UsageField = keyof UsageCounts;

export interface UsageStatsState {
  readonly version: 1;
  /** Machine device id → project folder name → counts. */
  readonly machines: Readonly<Record<string, Readonly<Record<string, UsageCounts>>>>;
  /** Keys already counted, oldest first, so a re-sent request never counts twice. */
  readonly counted: readonly string[];
}

export type UsageStatsStore = StoreApi<UsageStatsState>;

/** The key for a request whose working directory the computer did not name. */
export const NO_PROJECT = '(no folder)';
/** How many counted keys are remembered; older ones are forgotten first. */
export const MAX_COUNTED = 500;
const STORAGE_KEY = 'rc.usage-stats';

const ZERO: UsageCounts = { approvals: 0, denials: 0, sessions: 0 };

export function emptyUsageStats(): UsageStatsState {
  return { version: 1, machines: {}, counted: [] };
}

/** Where the counters persist between app starts. */
export interface UsageStatsStorage {
  read(): string | null;
  write(text: string): void;
}

/** `localStorage`; unavailable or failing storage only costs the counters. */
export function browserUsageStorage(storage: () => Storage | undefined): UsageStatsStorage {
  return {
    read() {
      try {
        return storage()?.getItem(STORAGE_KEY) ?? null;
      } catch {
        return null;
      }
    },
    write(text) {
      try {
        storage()?.setItem(STORAGE_KEY, text);
      } catch {
        // Counters that cannot be stored start again from zero next time.
      }
    },
  };
}

/** Counters that live as long as the page (tests, private windows). */
export function memoryUsageStorage(): UsageStatsStorage {
  let text: string | null = null;
  return {
    read: () => text,
    write(next) {
      text = next;
    },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0;

function isCounts(value: unknown): value is UsageCounts {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    isCount(value['approvals']) &&
    isCount(value['denials']) &&
    isCount(value['sessions'])
  );
}

/** Stored counters; `undefined` when the text is not a valid counters record. */
export function parseUsageStats(text: string): UsageStatsState | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value['version'] !== 1 || !isRecord(value['machines'])) return undefined;
  const machines = Object.values(value['machines']);
  const valid =
    machines.every((projects) => isRecord(projects) && Object.values(projects).every(isCounts)) &&
    Array.isArray(value['counted']) &&
    value['counted'].every((key) => typeof key === 'string');
  return valid ? (value as unknown as UsageStatsState) : undefined;
}

/** A store loaded from `storage` that writes every change back. */
export function createUsageStatsStore(storage: UsageStatsStorage): UsageStatsStore {
  const stored = storage.read();
  const initial = (stored === null ? undefined : parseUsageStats(stored)) ?? emptyUsageStats();
  const store = createStore<UsageStatsState>()(() => initial);
  store.subscribe((state) => {
    storage.write(JSON.stringify(state));
  });
  return store;
}

export interface UsageEvent {
  readonly machineId: string;
  readonly project: string | undefined;
  readonly field: UsageField;
  /** Counted once: a session per computer, a decision per request. */
  readonly key: string;
}

/** `state` with one more `field` for the project, unless `key` was already counted. */
export function countUsage(state: UsageStatsState, event: UsageEvent): UsageStatsState {
  if (state.counted.includes(event.key)) return state;
  const project = event.project ?? NO_PROJECT;
  const projects = state.machines[event.machineId] ?? {};
  const current = Object.hasOwn(projects, project) ? projects[project]! : ZERO;
  return {
    version: 1,
    machines: {
      ...state.machines,
      [event.machineId]: {
        ...projects,
        [project]: { ...current, [event.field]: current[event.field] + 1 },
      },
    },
    counted: [...state.counted, event.key].slice(-MAX_COUNTED),
  };
}

/** What a request view adds to the counters. */
function usageEvents(view: RequestView, sent: ReadonlyMap<string, 'allow' | 'deny'>): UsageEvent[] {
  const { machineId, request } = view;
  const events: UsageEvent[] = [
    {
      machineId,
      project: request.project,
      field: 'sessions',
      key: `session:${machineId}:${request.sessionId}`,
    },
  ];
  const kind = sent.get(request.id);
  if (view.result?.result === 'accepted' && kind !== undefined) {
    events.push({
      machineId,
      project: request.project,
      field: kind === 'allow' ? 'approvals' : 'denials',
      key: `decision:${request.id}`,
    });
  }
  return events;
}

/**
 * Counts what the realtime store shows: every session that asked, and every decision
 * this phone sent (`sent`, request id → kind) once the computer accepted it.
 */
export function trackUsage(
  realtime: RealtimeStore,
  stats: UsageStatsStore,
  sent: Map<string, 'allow' | 'deny'>,
): () => void {
  const update = (): void => {
    let next = stats.getState();
    for (const view of Object.values(realtime.getState().requests)) {
      for (const event of usageEvents(view, sent)) next = countUsage(next, event);
      if (view.result !== undefined) sent.delete(view.request.id);
    }
    if (next !== stats.getState()) stats.setState(next, true);
  };
  update();
  return realtime.subscribe(update);
}

/** Totals over every project of one computer. */
export function machineUsage(state: UsageStatsState, machineId: string): UsageCounts | undefined {
  const projects = state.machines[machineId];
  if (projects === undefined) return undefined;
  return Object.values(projects).reduce<UsageCounts>(
    (sum, counts) => ({
      approvals: sum.approvals + counts.approvals,
      denials: sum.denials + counts.denials,
      sessions: sum.sessions + counts.sessions,
    }),
    ZERO,
  );
}

/** `3 approved, 1 denied, 2 sessions`. */
export function usageSummary(counts: UsageCounts): string {
  const sessions = `${String(counts.sessions)} ${counts.sessions === 1 ? 'session' : 'sessions'}`;
  return `${String(counts.approvals)} approved, ${String(counts.denials)} denied, ${sessions}`;
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

/**
 * One project of a computer's own history (M2-06): `2 sessions, 40 tool calls, 1 h 5 min
 * active, 3 approved, 1 denied · last active 5 minutes ago`. `relayNow` is relay time,
 * the closest the phone has to the computer's clock.
 */
export function historySummary(entry: ProjectHistory, relayNow: number): string {
  const counts = [
    plural(entry.sessions, 'session', 'sessions'),
    plural(entry.toolCalls, 'tool call', 'tool calls'),
    `${activeTimeText(entry.activeMs)} active`,
    `${String(entry.approvals)} approved`,
    `${String(entry.denials)} denied`,
  ].join(', ');
  if (entry.lastActiveAt === null) return counts;
  return `${counts} · last active ${ago(Math.max(0, relayNow - entry.lastActiveAt))} ago`;
}
