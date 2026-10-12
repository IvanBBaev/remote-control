import type { DatabaseHealth } from '../ports/database-health.js';

/**
 * Stand-in for development without `RC_DATABASE_URL`: `/health` reports
 * `db: "disabled"`. Configuration refuses this in production.
 */
export const disabledDatabaseHealth: DatabaseHealth = {
  check: () => Promise.resolve('disabled'),
  close: () => Promise.resolve(),
};
