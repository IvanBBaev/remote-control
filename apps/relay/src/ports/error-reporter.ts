/**
 * What an error report may carry besides the error itself. Everything here is metadata
 * (D19): never a body, header, URL with ids, push endpoint or user-supplied string.
 */
export interface ErrorContext {
  /** Stable event name, e.g. `http_error`, `uncaught_exception`. */
  readonly event: string;
  /** Railway's request id (`req_id` in the logs), to find the matching log lines. */
  readonly reqId?: string;
  readonly method?: string;
  /** The route pattern (`/api/pairings/:id`), never the concrete URL. */
  readonly route?: string;
}

/** Error tracking for an unwatched service (D16: Sentry on the relay only). */
export interface ErrorReporter {
  /** Queues a report; never throws and never blocks the caller. */
  capture(error: unknown, context: ErrorContext): void;
  /** Waits for queued reports; resolves `false` when `timeoutMs` elapsed first. */
  flush(timeoutMs: number): Promise<boolean>;
}

/** The reporter when `RC_SENTRY_DSN` is unset. */
export const noopErrorReporter: ErrorReporter = {
  capture: () => undefined,
  flush: () => Promise.resolve(true),
};
