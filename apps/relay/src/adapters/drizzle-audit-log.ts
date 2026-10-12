import { and, asc, count, eq, gte, isNull, sql } from 'drizzle-orm';

import { auditLog, devices, users } from '../db/schema.js';
import type { AdminStatsStore, AuditLogStore } from '../ports/audit-log.js';
import type { RelayDatabase } from '../ports/db.js';

/** The {@link AuditLogStore} and {@link AdminStatsStore} over drizzle; times come from the Clock port. */
export function createDrizzleAuditLog(orm: RelayDatabase): AuditLogStore & AdminStatsStore {
  return {
    async append(rows) {
      if (rows.length === 0) return;
      await orm.insert(auditLog).values(
        rows.map((row) => ({
          userId: row.userId,
          deviceId: row.deviceId,
          event: row.event,
          decisionHash: row.decisionHash ?? null,
          at: new Date(row.at),
        })),
      );
    },

    async stats(since) {
      const [userRow] = await orm.select({ n: count() }).from(users);
      const deviceRows = await orm
        .select({ kind: devices.kind, n: count() })
        .from(devices)
        .where(isNull(devices.revokedAt))
        .groupBy(devices.kind);
      const day = sql<string>`to_char(${auditLog.at} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
      const pushRows = await orm
        .select({ day, n: count() })
        .from(auditLog)
        .where(and(eq(auditLog.event, 'push_sent'), gte(auditLog.at, new Date(since))))
        .groupBy(day)
        .orderBy(asc(day));
      const byKind = new Map(deviceRows.map((row) => [row.kind, row.n]));
      return {
        users: userRow?.n ?? 0,
        devices: { phone: byKind.get('phone') ?? 0, agent: byKind.get('agent') ?? 0 },
        pushesPerDay: pushRows.map((row) => ({ day: row.day, count: row.n })),
      };
    },
  };
}
