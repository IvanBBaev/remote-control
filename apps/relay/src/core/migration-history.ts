/** One migration as identified by drizzle: its journal timestamp and SQL hash. */
export interface MigrationEntry {
  /** Journal `when` (ms); drizzle stores it as `created_at`. */
  readonly createdAt: number;
  readonly hash: string;
}

/** Thrown when the database's migration history and the shipped migrations disagree. */
export class MigrationHistoryError extends Error {
  override readonly name = 'MigrationHistoryError';
}

/**
 * Forward-only guard (D17), checked under the migration lock before anything is
 * applied. Drizzle applies only migrations newer than the newest applied one, so:
 * - an applied migration whose SQL changed afterwards would silently diverge → refuse;
 * - a shipped migration older than the newest applied one that was never applied (a
 *   migration inserted into the past) would be skipped forever → refuse.
 * Applied migrations unknown to this build (the database is ahead, e.g. during a
 * rollback) are allowed: nothing is undone, nothing is applied.
 */
export function verifyMigrationHistory(
  shipped: readonly MigrationEntry[],
  applied: readonly MigrationEntry[],
): void {
  const appliedByTime = new Map(applied.map((entry) => [entry.createdAt, entry.hash]));
  const newestApplied = Math.max(-Infinity, ...appliedByTime.keys());
  for (const migration of shipped) {
    const appliedHash = appliedByTime.get(migration.createdAt);
    if (appliedHash !== undefined && appliedHash !== migration.hash) {
      throw new MigrationHistoryError(
        `migration ${migration.createdAt} was changed after it was applied`,
      );
    }
    if (appliedHash === undefined && migration.createdAt <= newestApplied) {
      throw new MigrationHistoryError(
        `migration ${migration.createdAt} is older than the newest applied migration and was never applied`,
      );
    }
  }
}
