import { readMigrationFiles } from 'drizzle-orm/migrator';

import { verifyMigrationHistory, type MigrationEntry } from '../core/migration-history.js';

/**
 * Key of the session-level advisory lock that serialises migrators (D17, 03 §5.9).
 * Arbitrary but fixed: every relay process and every pre-deploy run uses it.
 */
export const MIGRATION_LOCK_KEY = 7_263_000_008;

/** How long a migrator waits for another one to finish before failing. */
export const DEFAULT_LOCK_TIMEOUT_MS = 60_000;

const MIGRATIONS_TABLE = 'drizzle.__drizzle_migrations';

/**
 * One database connection: the lock, the history reads and the migrations themselves
 * must all run on it, because a session-level advisory lock belongs to a connection.
 */
export interface MigrationSession {
  query(text: string): Promise<readonly Record<string, unknown>[]>;
  /** Applies pending migrations with drizzle's migrator on this same connection. */
  applyPending(): Promise<void>;
}

export interface MigrationReport {
  /** Migrations applied by this run (0 when another migrator or a previous boot did it). */
  readonly applied: number;
  /** Migrations recorded in the database after this run. */
  readonly total: number;
}

export interface MigrateOptions {
  readonly migrationsFolder: string;
  readonly lockTimeoutMs?: number;
}

async function appliedMigrations(session: MigrationSession): Promise<MigrationEntry[]> {
  const [presence] = await session.query(
    `SELECT to_regclass('${MIGRATIONS_TABLE}') IS NOT NULL AS present`,
  );
  if (presence?.['present'] !== true) return [];
  const rows = await session.query(`SELECT hash, created_at FROM ${MIGRATIONS_TABLE}`);
  return rows.map((row) => ({ hash: String(row['hash']), createdAt: Number(row['created_at']) }));
}

/**
 * Applies the shipped migrations forward-only under a Postgres advisory lock (D17).
 * Concurrent callers (two relay boots, a boot and the Railway pre-deploy) queue on the
 * lock; whoever comes second finds nothing to apply. Never runs down-migrations.
 */
export async function migrateWithLock(
  session: MigrationSession,
  options: MigrateOptions,
): Promise<MigrationReport> {
  const shipped = readMigrationFiles({ migrationsFolder: options.migrationsFolder }).map(
    (migration) => ({ createdAt: migration.folderMillis, hash: migration.hash }),
  );
  const lockTimeoutMs = Math.trunc(options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  await session.query(`SET lock_timeout = ${lockTimeoutMs}`);
  try {
    await session.query(`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
  } finally {
    await session.query('RESET lock_timeout');
  }
  try {
    const before = await appliedMigrations(session);
    verifyMigrationHistory(shipped, before);
    await session.applyPending();
    const after = await appliedMigrations(session);
    return { applied: after.length - before.length, total: after.length };
  } finally {
    await session.query(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
  }
}
