import type { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

import type { DatabaseStatus } from '../core/health-report.js';
import { migrateWithLock, type MigrateOptions } from '../db/migrator.js';
import * as schema from '../db/schema.js';
import type { Db } from '../ports/db.js';

/**
 * In-process `Db` on PGlite for tests and the test harness (D18) — never wired in
 * production (PGlite is a dev dependency and stays out of the bundle). PGlite is a
 * single connection, so the advisory lock is taken but never contended here; the
 * concurrent case is proven against real Postgres in the `pg-real` project.
 */
export function createPgliteDb(client: PGlite, options: MigrateOptions): Db {
  const orm = drizzle(client, { schema });
  return {
    orm,
    async check(): Promise<DatabaseStatus> {
      try {
        await client.query('SELECT 1');
        return 'ok';
      } catch {
        return 'error';
      }
    },
    close: () => client.close(),
    migrate: () =>
      migrateWithLock(
        {
          query: async (text) => (await client.query<Record<string, unknown>>(text)).rows,
          applyPending: () => migrate(orm, { migrationsFolder: options.migrationsFolder }),
        },
        options,
      ),
  };
}
