import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import type { Logger } from 'pino';

import { migrateWithLock, type MigrateOptions, type MigrationReport } from '../db/migrator.js';
import * as schema from '../db/schema.js';
import type { Db } from '../ports/db.js';
import { PgDatabaseHealth } from './pg-database-health.js';
import { createPgPool } from './pg-pool.js';

const MIGRATION_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Runs the migrations on a dedicated connection (03 §5.9): the pool's 2 s query bound
 * must not cut a migration short, and the advisory lock has to live on the same
 * connection as the statements it protects.
 */
export async function migratePostgres(
  connectionString: string,
  options: MigrateOptions,
): Promise<MigrationReport> {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: MIGRATION_CONNECT_TIMEOUT_MS,
  });
  // A dropped connection surfaces as a rejected query; without a listener it would crash.
  client.on('error', () => undefined);
  await client.connect();
  try {
    const orm = drizzle(client, { schema });
    return await migrateWithLock(
      {
        query: async (text) => (await client.query<Record<string, unknown>>(text)).rows,
        applyPending: () => migrate(orm, { migrationsFolder: options.migrationsFolder }),
      },
      options,
    );
  } finally {
    await client.end();
  }
}

/** Production `Db`: drizzle over the bounded pool, `/health` on the same pool. */
export function createPgDb(connectionString: string, logger: Logger, migrationsFolder: string): Db {
  const pool = createPgPool(connectionString, logger);
  const health = new PgDatabaseHealth(pool);
  return {
    orm: drizzle(pool, { schema }),
    check: () => health.check(),
    close: () => health.close(),
    migrate: () => migratePostgres(connectionString, { migrationsFolder }),
  };
}
