import type { Logger } from 'pino';

import type { DrainState } from './core/drain-state.js';

/** D15: the process exits within 25 s of SIGTERM (Railway `drainingSeconds` is 30). */
export const SHUTDOWN_TIMEOUT_MS = 25_000;

export type ShutdownSignal = 'SIGTERM' | 'SIGINT';

/** The part of `process` that delivers signals; tests pass an `EventEmitter`. */
export interface SignalSource {
  once(signal: ShutdownSignal, listener: () => void): unknown;
}

export interface ShutdownDeps {
  readonly close: () => Promise<void>;
  readonly drain: DrainState;
  readonly logger: Logger;
  readonly signals: SignalSource;
  readonly exit: (code: number) => void;
  readonly timeoutMs?: number;
  /** Schedules the hard-exit fallback and returns its cancel function. */
  readonly schedule?: (callback: () => void, ms: number) => () => void;
}

function scheduleUnref(callback: () => void, ms: number): () => void {
  const timer = setTimeout(callback, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

/**
 * Graceful drain on SIGTERM/SIGINT (D15, 03 §5.13): mark draining so `/health`
 * answers 503, close the app (which stops accepting and, from the WS work package on,
 * closes sockets with 1012), exit 0; a fallback timer exits 1 if closing hangs.
 * Returns the trigger so callers and tests can start the same sequence directly.
 */
export function installShutdown(deps: ShutdownDeps): (signal: ShutdownSignal) => Promise<void> {
  const schedule = deps.schedule ?? scheduleUnref;
  let started: Promise<void> | undefined;

  const shutdown = (signal: ShutdownSignal): Promise<void> => {
    if (started) return started;
    deps.drain.begin();
    deps.logger.info({ event: 'shutdown_started', signal }, 'draining');
    const cancel = schedule(() => {
      deps.logger.error({ event: 'shutdown_timeout' }, 'forced exit');
      deps.exit(1);
    }, deps.timeoutMs ?? SHUTDOWN_TIMEOUT_MS);
    started = deps.close().then(
      () => {
        cancel();
        deps.logger.info({ event: 'shutdown_complete' }, 'closed');
        deps.exit(0);
      },
      (error: unknown) => {
        cancel();
        deps.logger.error({ event: 'shutdown_failed', err: error }, 'close failed');
        deps.exit(1);
      },
    );
    return started;
  };

  deps.signals.once('SIGTERM', () => void shutdown('SIGTERM'));
  deps.signals.once('SIGINT', () => void shutdown('SIGINT'));
  return shutdown;
}
