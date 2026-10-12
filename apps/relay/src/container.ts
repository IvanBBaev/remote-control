import { webCryptoRandom } from '@remote-control/crypto';
import { createLogger } from '@remote-control/log';
import type { Clock, Random } from '@remote-control/protocol';
import type { DestinationStream, Logger } from 'pino';

import { disabledDatabaseHealth } from './adapters/disabled-database-health.js';
import { createDrizzleAccountStore } from './adapters/drizzle-account-store.js';
import { createPgDb } from './adapters/pg-db.js';
import { createScryptSecretHasher } from './adapters/scrypt-secret-hasher.js';
import { createSimpleWebAuthn } from './adapters/simple-webauthn.js';
import { createDrizzleDeviceDirectory } from './adapters/drizzle-device-directory.js';
import { systemClock } from './adapters/system-clock.js';
import { systemTimer } from './adapters/system-timer.js';
import type { Config } from './config.js';
import { AccountService } from './core/account-service.js';
import { DrainState } from './core/drain-state.js';
import { DEVICE_CAP } from './core/hub-limits.js';
import { LocalHub } from './core/local-hub.js';
import { RelayRouter } from './core/relay-router.js';
import { MIGRATIONS_DIR } from './package-paths.js';
import type { DatabaseHealth } from './ports/database-health.js';
import type { Db } from './ports/db.js';
import type { DeviceDirectory } from './ports/device-directory.js';
import type { HubPort } from './ports/hub.js';

export interface Container {
  readonly logger: Logger;
  readonly clock: Clock;
  /** The relay database; `undefined` when no database URL is configured. */
  readonly db: Db | undefined;
  /** `/health`'s view of `db` (`disabled` without one). */
  readonly database: DatabaseHealth;
  readonly drain: DrainState;
  readonly random: Random;
  /** Accounts and passkeys (D8); `undefined` without a database. */
  readonly accounts: AccountService | undefined;
  /** The WebSocket hub (D15); `undefined` without a database. */
  readonly relay:
    | { readonly router: RelayRouter; readonly hub: HubPort; readonly directory: DeviceDirectory }
    | undefined;
}

/** The relying party name shown by the passkey manager. */
const RP_NAME = 'remote-control';

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
  const clock = systemClock;
  const random = webCryptoRandom;
  const directory = db && createDrizzleDeviceDirectory(db.orm);
  const hub = new LocalHub(clock, DEVICE_CAP);
  return {
    logger,
    clock,
    db,
    database: db ?? disabledDatabaseHealth,
    drain: new DrainState(),
    random,
    accounts:
      db &&
      new AccountService({
        store: createDrizzleAccountStore(db.orm),
        webauthn: createSimpleWebAuthn({ id: config.rpId, origin: config.origin, name: RP_NAME }),
        hasher: createScryptSecretHasher(random),
        clock,
        random,
      }),
    relay: directory && {
      router: new RelayRouter({ clock, timer: systemTimer, hub, directory, logger }),
      hub,
      directory,
    },
  };
}
