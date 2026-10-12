import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import type * as schema from '../db/schema.js';
import type { MigrationReport } from '../db/migrator.js';
import type { DatabaseHealth } from './database-health.js';

/** The typed query builder over the relay schema, independent of the driver. */
export type RelayDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * The relay's database (ROADMAP §5 `Db` port): `pg` in production
 * (`adapters/pg-db.ts`), PGlite in tests (`adapters/pglite-db.ts`).
 */
export interface Db extends DatabaseHealth {
  readonly orm: RelayDatabase;
  /** Applies pending migrations under the advisory lock; a no-op when up to date. */
  migrate(): Promise<MigrationReport>;
}
