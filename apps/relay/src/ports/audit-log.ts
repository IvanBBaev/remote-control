import type { DeviceKind } from './device-directory.js';

/** Audit events the relay core writes outside a store transaction (M1-13, 03 W12). */
export type RelayAuditEvent = 'decision_forwarded' | 'push_sent';

/** One `audit_log` row: event, user, device, time — no bodies (02 §5.6, D19). */
export interface AuditRow {
  readonly userId: string;
  readonly deviceId: string;
  readonly event: RelayAuditEvent;
  /** The 32-byte decision hash, on `decision_forwarded` only. */
  readonly decisionHash?: Uint8Array;
  readonly at: number;
}

/** Appends audit rows (`adapters/drizzle-audit-log.ts`). */
export interface AuditLogStore {
  append(rows: readonly AuditRow[]): Promise<void>;
}

/** Pushes sent on one UTC day (`YYYY-MM-DD`). */
export interface DailyCount {
  readonly day: string;
  readonly count: number;
}

/** Aggregates for `GET /api/admin/counters`: counts only, never ids or names. */
export interface AdminStats {
  readonly users: number;
  /** Live (not revoked) devices by kind. */
  readonly devices: Readonly<Record<DeviceKind, number>>;
  /** `push_sent` rows per UTC day from `since` on, oldest first, days without pushes omitted. */
  readonly pushesPerDay: readonly DailyCount[];
}

export interface AdminStatsStore {
  stats(since: number): Promise<AdminStats>;
}
