import pg from 'pg';
import type { Logger } from 'pino';

/** Health-check bound from 03 §5.12 and the pool cap from 06 §5.1. */
const TIMEOUT_MS = 2_000;
const MAX_CONNECTIONS = 10;

/**
 * Creates the relay's Postgres pool. Connections open lazily; an idle-client error is
 * logged (code only, never the connection string) instead of crashing the process.
 */
export function createPgPool(connectionString: string, logger: Logger): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: MAX_CONNECTIONS,
    connectionTimeoutMillis: TIMEOUT_MS,
    query_timeout: TIMEOUT_MS,
  });
  pool.on('error', (error: Error & { code?: string }) => {
    logger.warn({ event: 'db_pool_error', code: error.code ?? 'unknown' }, 'idle client error');
  });
  return pool;
}
