import type { Clock } from '@remote-control/protocol';

/** A cancellable one-shot timer. */
export interface TimerHandle {
  cancel(): void;
}

/**
 * The phone's clock and scheduler in one port, the shape of the harness `FakeClock`, so
 * tests drive heartbeats, backoff and polling without waiting in real time.
 */
export interface Timer extends Clock {
  /** Runs `callback` once after `ms` milliseconds unless cancelled first. */
  after(ms: number, callback: () => void): TimerHandle;
}
