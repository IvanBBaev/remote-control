import { createLogger } from '@remote-control/log';
import type { Clock } from '@remote-control/protocol';
import type { DestinationStream, Logger } from 'pino';

import { disabledDatabaseHealth } from './adapters/disabled-database-health.js';
import { PgDatabaseHealth } from './adapters/pg-database-health.js';
import { createPgPool } from './adapters/pg-pool.js';
import { systemClock } from './adapters/system-clock.js';
import type { Config } from './config.js';
import { DrainState } from './core/drain-state.js';
import type { DatabaseHealth } from './ports/database-health.js';

export interface Container {
  readonly logger: Logger;
  readonly clock: Clock;
  readonly database: DatabaseHealth;
  readonly drain: DrainState;
}

export interface ContainerOptions {
  /** Log destination; default stdout. Tests pass a memory destination. */
  readonly destination?: DestinationStream;
}

/** The only place where ports are bound to concrete adapters (ROADMAP §5). */
export function createContainer(config: Config, options: ContainerOptions = {}): Container {
  const logger = createLogger({
    name: 'relay',
    level: config.logLevel,
    ...(options.destination === undefined ? {} : { destination: options.destination }),
  });
  const database =
    config.databaseUrl === undefined
      ? disabledDatabaseHealth
      : new PgDatabaseHealth(createPgPool(config.databaseUrl, logger));
  return { logger, clock: systemClock, database, drain: new DrainState() };
}
