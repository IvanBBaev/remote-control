import type { Logger } from 'pino';

import type { ErrorReporter } from './ports/error-reporter.js';

/** How long a crash waits for its error report before the process exits. */
export const CRASH_FLUSH_TIMEOUT_MS = 2_000;

export type CrashEvent = 'uncaughtException' | 'unhandledRejection';

/** The part of `process` that reports crashes; tests pass an `EventEmitter`. */
export interface CrashSource {
  on(event: CrashEvent, listener: (error: unknown) => void): unknown;
}

export interface CrashHandlerDeps {
  readonly source: CrashSource;
  readonly errors: ErrorReporter;
  readonly logger: Logger;
  readonly exit: (code: number) => void;
  readonly flushTimeoutMs?: number;
}

const EVENT_NAMES: Readonly<Record<CrashEvent, string>> = {
  uncaughtException: 'uncaught_exception',
  unhandledRejection: 'unhandled_rejection',
};

/**
 * An uncaught exception or unhandled rejection is logged, reported (D16) and ends the
 * process with exit 1; Railway restarts it (`ON_FAILURE`). The first crash wins: a
 * second one while the report is flushing is logged only.
 */
export function installCrashHandlers(deps: CrashHandlerDeps): void {
  let crashing = false;
  const handle = (kind: CrashEvent) => (error: unknown) => {
    const event = EVENT_NAMES[kind];
    deps.logger.fatal({ event, err: error }, 'process crashed');
    if (crashing) return;
    crashing = true;
    deps.errors.capture(error, { event });
    void deps.errors
      .flush(deps.flushTimeoutMs ?? CRASH_FLUSH_TIMEOUT_MS)
      .finally(() => deps.exit(1));
  };
  deps.source.on('uncaughtException', handle('uncaughtException'));
  deps.source.on('unhandledRejection', handle('unhandledRejection'));
}
