import type { Timer, TimerHandle } from '../ports/timer.js';
import type { PendingStore } from './pending-store.js';

/** How often a running agent re-reads the pause switch while it holds requests. */
export const PAUSE_POLL_MS = 1_000;

export interface PauseWatchOptions {
  readonly store: PendingStore;
  readonly timer: Timer;
  /** The pause switch; a check that throws counts as not paused. */
  readonly paused: () => Promise<boolean>;
  readonly pollMs?: number;
}

export interface PauseWatch {
  /** Call on every store event: starts polling while requests are held. */
  pendingChanged(): void;
  stop(): void;
}

/**
 * Hands requests that were already held back to the terminal once `remotectl pause` runs
 * (M1-03): while the store holds anything, the pause switch is re-read every
 * {@link PAUSE_POLL_MS}; when it is on, every held request ends with a `paused` handoff.
 * Nothing is polled while the store is empty (new hooks check the switch themselves).
 */
export function createPauseWatch(options: PauseWatchOptions): PauseWatch {
  const { store, timer } = options;
  const pollMs = options.pollMs ?? PAUSE_POLL_MS;
  let handle: TimerHandle | undefined;
  let stopped = false;

  function schedule(): void {
    if (stopped || handle !== undefined || store.list().length === 0) return;
    handle = timer.after(pollMs, () => void poll());
  }

  async function poll(): Promise<void> {
    const paused = await options.paused().catch(() => false);
    handle = undefined;
    if (stopped) return;
    if (paused) store.releaseAll('paused');
    schedule();
  }

  return {
    pendingChanged: schedule,
    stop() {
      stopped = true;
      handle?.cancel();
      handle = undefined;
    },
  };
}
