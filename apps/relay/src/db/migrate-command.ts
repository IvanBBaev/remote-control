import { createLogger } from '@remote-control/log';
import type { DestinationStream } from 'pino';

import { migratePostgres } from '../adapters/pg-db.js';
import { loadConfig } from '../config.js';
import { MIGRATIONS_DIR } from '../package-paths.js';
import type { MigrationReport } from './migrator.js';

export interface MigrateCommandOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly destination?: DestinationStream;
  /** The migration runner; tests inject a fake, production uses `migratePostgres`. */
  readonly migrate?: (connectionString: string) => Promise<MigrationReport>;
}

/**
 * `node dist/migrate.js` — the Railway pre-deploy command (D16, D17). Exit code 0 when
 * the database is up to date, 1 otherwise, so a broken migration fails the deploy
 * before traffic switches.
 */
export async function runMigrateCommand(options: MigrateCommandOptions): Promise<number> {
  const logger = createLogger({
    name: 'relay-migrate',
    level: 'info',
    ...(options.destination === undefined ? {} : { destination: options.destination }),
  });
  const migrate =
    options.migrate ??
    ((connectionString: string) =>
      migratePostgres(connectionString, { migrationsFolder: MIGRATIONS_DIR }));
  try {
    const { databaseUrl } = loadConfig(options.env);
    if (databaseUrl === undefined) {
      logger.error({ event: 'migrations_failed' }, 'RC_DATABASE_URL (or DATABASE_URL) is not set');
      return 1;
    }
    const report = await migrate(databaseUrl);
    logger.info({ event: 'migrations_applied', ...report }, 'database is up to date');
    return 0;
  } catch (error) {
    logger.error({ event: 'migrations_failed', err: error }, 'migration failed');
    return 1;
  }
}
