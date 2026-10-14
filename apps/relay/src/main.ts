import { readFileSync } from 'node:fs';

import type { FastifyInstance } from 'fastify';
import type { DestinationStream } from 'pino';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createContainer, type ContainerOptions } from './container.js';
import { installCrashHandlers, type CrashSource } from './crash-handlers.js';
import { DEFAULT_PUBLIC_DIR, PACKAGE_JSON } from './package-paths.js';
import type { Db } from './ports/db.js';
import type { ErrorReporter } from './ports/error-reporter.js';
import { installShutdown, type ShutdownSignal, type SignalSource } from './shutdown.js';

export interface StartOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signals: SignalSource;
  readonly exit: (code: number) => void;
  readonly destination?: DestinationStream;
  /** Overrides the `pg` database built from the config (tests pass a PGlite `Db`). */
  readonly db?: Db;
  /** Uncaught exceptions and unhandled rejections to report and exit on (`process`). */
  readonly crashes?: CrashSource;
}

export interface RunningServer {
  readonly app: FastifyInstance;
  /** Starts the same drain sequence a SIGTERM would. */
  readonly shutdown: (signal: ShutdownSignal) => Promise<void>;
  readonly errors: ErrorReporter;
}

/** Shutdown waits this long for queued error reports. */
const ERRORS_FLUSH_TIMEOUT_MS = 2_000;

function packageVersion(): string {
  const parsed = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { version?: unknown };
  return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
}

/**
 * Composition root: config → container → migrate → app → listen → shutdown handlers.
 * Migrations also run as the Railway pre-deploy command; at boot they are a no-op
 * then, and the advisory lock serialises an overlapping replica (D17).
 */
export async function startServer(options: StartOptions): Promise<RunningServer> {
  const config = loadConfig(options.env);
  const containerOptions: ContainerOptions = {
    ...(options.destination === undefined ? {} : { destination: options.destination }),
    ...(options.db === undefined ? {} : { db: options.db }),
  };
  const container = createContainer(config, containerOptions);
  if (options.crashes !== undefined) {
    installCrashHandlers({
      source: options.crashes,
      errors: container.errors,
      logger: container.logger,
      exit: options.exit,
    });
  }
  if (container.db !== undefined) {
    try {
      const report = await container.db.migrate();
      container.logger.info({ event: 'migrations_applied', ...report }, 'database is up to date');
    } catch (error) {
      await container.db.close();
      throw error;
    }
  }
  const app = await buildApp({
    logger: container.logger,
    clock: container.clock,
    database: container.database,
    drain: container.drain,
    version: packageVersion(),
    commit: config.commit,
    publicDir: config.publicDir ?? DEFAULT_PUBLIC_DIR,
    tls: config.tls && {
      cert: readFileSync(config.tls.certFile),
      key: readFileSync(config.tls.keyFile),
    },
    trustProxyHops: config.trustProxyHops,
    auth: container.accounts && { service: container.accounts, origin: config.origin },
    relay: container.relay,
    push: container.push,
    admin: container.admin,
    spike: container.spike,
    errors: container.errors,
  });
  app.addHook('onClose', async () => {
    // Say goodbye first: the other replicas drop this one's devices at once.
    await container.relay?.cluster?.stop();
    // Background pushes and audit writes finish before the pool closes (pushes write audit rows).
    await container.push?.notifier.idle();
    await container.audit?.idle();
    await container.errors.flush(ERRORS_FLUSH_TIMEOUT_MS);
    await container.database.close();
  });

  try {
    await container.relay?.cluster?.start();
  } catch (error) {
    await app.close();
    throw error;
  }
  await app.listen({ host: config.host, port: config.port });
  const shutdown = installShutdown({
    close: () => app.close(),
    drain: container.drain,
    logger: container.logger,
    signals: options.signals,
    exit: options.exit,
  });
  return { app, shutdown, errors: container.errors };
}
