import { createLogger } from '@remote-control/log';
import type { Clock } from '@remote-control/protocol';
import type { DestinationStream, Logger } from 'pino';

import { disabledDatabaseHealth } from './adapters/disabled-database-health.js';
import { createPgDb } from './adapters/pg-db.js';
import { systemClock } from './adapters/system-clock.js';
import type { Config } from './config.js';
import { DrainState } from './core/drain-state.js';
import { MIGRATIONS_DIR } from './package-paths.js';
import type { DatabaseHealth } from './ports/database-health.js';
import type { Db } from './ports/db.js';

export interface Container {
  readonly logger: Logger;
  readonly clock: Clock;
  /** The relay database; `undefined` when no database URL is configured. */
  readonly db: Db | undefined;
  /** `/health`'s view of `db` (`disabled` without one). */
  readonly database: DatabaseHealth;
  readonly drain: DrainState;
}

export interface ContainerOptions {
  /** Log destination; default stdout. Tests pass a memory destination. */
  readonly destination?: DestinationStream;
  /** Overrides the `pg` database (tests pass a PGlite `Db`). */
  readonly db?: Db;
}

/** The only place where ports are bound to concrete adapters (ROADMAP §5). */
export function createContainer(config: Config, options: ContainerOptions = {}): Container {
  const logger = createLogger({
    name: 'relay',
    level: config.logLevel,
    ...(options.destination === undefined ? {} : { destination: options.destination }),
  });
  const db =
    options.db ??
    (config.databaseUrl === undefined
      ? undefined
      : createPgDb(config.databaseUrl, logger, MIGRATIONS_DIR));
  return {
    logger,
    clock: systemClock,
    db,
    database: db ?? disabledDatabaseHealth,
    drain: new DrainState(),
  };
}
