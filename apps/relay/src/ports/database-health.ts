import type { DatabaseStatus } from '../core/health-report.js';

/** Liveness probe of the relay's database, used by `/health`. */
export interface DatabaseHealth {
  /** Resolves `error` instead of rejecting when the database is unreachable. */
  check(): Promise<DatabaseStatus>;
  /** Releases the connections behind the probe; called once on shutdown. */
  close(): Promise<void>;
}
