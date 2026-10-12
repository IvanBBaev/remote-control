import type { DatabaseStatus } from '../core/health-report.js';
import type { DatabaseHealth } from '../ports/database-health.js';

/** The part of a `pg.Pool` the probe needs; tests pass a fake. */
export interface Queryable {
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

/**
 * `SELECT 1` against the pool (03 §5.12). The 2 s bound comes from the pool's
 * `connectionTimeoutMillis` / `query_timeout`, set where the pool is created.
 */
export class PgDatabaseHealth implements DatabaseHealth {
  readonly #pool: Queryable;

  constructor(pool: Queryable) {
    this.#pool = pool;
  }

  async check(): Promise<DatabaseStatus> {
    try {
      await this.#pool.query('SELECT 1');
      return 'ok';
    } catch {
      return 'error';
    }
  }

  close(): Promise<void> {
    return this.#pool.end();
  }
}
