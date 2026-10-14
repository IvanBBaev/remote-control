/** One `NOTIFY`: a channel name and a payload under Postgres' 8000-byte limit (03 F24). */
export interface Notification {
  readonly channel: string;
  readonly payload: string;
}

/**
 * Postgres `LISTEN`/`NOTIFY` as the `PgNotifyHub` needs it (D15, 03 §5.14, ADR 0012):
 * `pg` in production (`adapters/pg-notify-bus.ts`), PGlite in tests
 * (`adapters/pglite-notify-bus.ts`). Nothing is written to a table.
 */
export interface NotifyBus {
  /** Starts listening on `channels`; resolves once every `LISTEN` is in effect. */
  listen(
    channels: readonly string[],
    onMessage: (channel: string, payload: string) => void,
  ): Promise<void>;
  /**
   * Sends `notifications` in one transaction: they are delivered together, in order, on
   * commit (03 F24). Calls are serialised, so a later call is never delivered first.
   */
  publish(notifications: readonly Notification[]): Promise<void>;
  /** Called after the listening connection was lost and `LISTEN` re-established. */
  onReconnect(listener: () => void): void;
  /** Stops listening and releases the connection. */
  close(): Promise<void>;
}
