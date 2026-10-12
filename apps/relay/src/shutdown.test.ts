import { EventEmitter } from 'node:events';

import { createLogger, createMemoryDestination } from '@remote-control/log';
import { describe, expect, it, vi } from 'vitest';

import { DrainState } from './core/drain-state.js';
import { installShutdown, SHUTDOWN_TIMEOUT_MS, type ShutdownDeps } from './shutdown.js';

function setup(close: () => Promise<void>) {
  const signals = new EventEmitter();
  const exit = vi.fn<(code: number) => void>();
  const drain = new DrainState();
  const scheduled: { callback: () => void; ms: number; cancelled: boolean }[] = [];
  const deps: ShutdownDeps = {
    close,
    drain,
    exit,
    signals,
    logger: createLogger({ level: 'silent', destination: createMemoryDestination() }),
    schedule: (callback, ms) => {
      const entry = { callback, ms, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  };
  return { signals, exit, drain, scheduled, shutdown: installShutdown(deps) };
}

describe('installShutdown', () => {
  it('drains, closes and exits 0 on SIGTERM, cancelling the fallback timer', async () => {
    const close = vi.fn(() => Promise.resolve());
    const { signals, exit, drain, scheduled, shutdown } = setup(close);

    signals.emit('SIGTERM');
    expect(drain.isDraining()).toBe(true);
    await shutdown('SIGTERM');

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.ms).toBe(SHUTDOWN_TIMEOUT_MS);
    expect(scheduled[0]?.cancelled).toBe(true);
  });

  it('runs the sequence once even if SIGINT follows SIGTERM', async () => {
    const close = vi.fn(() => Promise.resolve());
    const { signals, exit, shutdown } = setup(close);
    signals.emit('SIGTERM');
    signals.emit('SIGINT');
    await shutdown('SIGINT');
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('exits 1 when closing fails', async () => {
    const { exit, scheduled, shutdown } = setup(() => Promise.reject(new Error('stuck')));
    await shutdown('SIGTERM');
    expect(exit).toHaveBeenCalledWith(1);
    expect(scheduled[0]?.cancelled).toBe(true);
  });

  it('forces exit 1 when closing hangs past the timeout', () => {
    const { exit, scheduled, shutdown } = setup(() => new Promise<void>(() => {}));
    void shutdown('SIGTERM');
    expect(exit).not.toHaveBeenCalled();
    scheduled[0]?.callback();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('schedules a real unref-ed timer by default', async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn<(code: number) => void>();
      const shutdown = installShutdown({
        close: () => new Promise<void>(() => {}),
        drain: new DrainState(),
        exit,
        signals: new EventEmitter(),
        logger: createLogger({ level: 'silent', destination: createMemoryDestination() }),
        timeoutMs: 100,
      });
      void shutdown('SIGTERM');
      await vi.advanceTimersByTimeAsync(100);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
