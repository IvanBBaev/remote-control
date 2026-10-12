/** A cancellable one-shot timer. */
export interface TimerHandle {
  cancel(): void;
}

/**
 * Schedules callbacks. Core code never calls `setTimeout` directly, so tests drive
 * deadlines with a manual timer instead of waiting in real time.
 */
export interface Timer {
  /** Runs `callback` once after `ms` milliseconds unless cancelled first. */
  after(ms: number, callback: () => void): TimerHandle;
}
