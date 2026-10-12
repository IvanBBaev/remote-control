import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';
import type { DestinationStream } from 'pino';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createContainer } from './container.js';
import { installShutdown, type ShutdownSignal, type SignalSource } from './shutdown.js';

/**
 * Both `src/main.ts` (dev, tsx) and the bundled `dist/server.js` sit one level below
 * the package root, so these resolve the same way in dev, tests and the image.
 */
const PACKAGE_JSON = new URL('../package.json', import.meta.url);
const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL('../../web/dist', import.meta.url));

export interface StartOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signals: SignalSource;
  readonly exit: (code: number) => void;
  readonly destination?: DestinationStream;
}

export interface RunningServer {
  readonly app: FastifyInstance;
  /** Starts the same drain sequence a SIGTERM would. */
  readonly shutdown: (signal: ShutdownSignal) => Promise<void>;
}

function packageVersion(): string {
  const parsed = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { version?: unknown };
  return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
}

/** Composition root: config → container → app → listen → shutdown handlers. */
export async function startServer(options: StartOptions): Promise<RunningServer> {
  const config = loadConfig(options.env);
  const container = createContainer(
    config,
    options.destination === undefined ? {} : { destination: options.destination },
  );
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
  });
  app.addHook('onClose', () => container.database.close());

  await app.listen({ host: config.host, port: config.port });
  const shutdown = installShutdown({
    close: () => app.close(),
    drain: container.drain,
    logger: container.logger,
    signals: options.signals,
    exit: options.exit,
  });
  return { app, shutdown };
}
