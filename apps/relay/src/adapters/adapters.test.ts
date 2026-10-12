import { createLogger, createMemoryDestination } from '@remote-control/log';
import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../config.js';
import { createContainer } from '../container.js';
import { disabledDatabaseHealth } from './disabled-database-health.js';
import { PgDatabaseHealth, type Queryable } from './pg-database-health.js';
import { createPgPool } from './pg-pool.js';
import type { Db } from '../ports/db.js';
import { systemClock } from './system-clock.js';

describe('PgDatabaseHealth', () => {
  it('reports ok when SELECT 1 succeeds and error when it throws', async () => {
    const query = vi.fn<Queryable['query']>(() => Promise.resolve({}));
    const end = vi.fn<Queryable['end']>(() => Promise.resolve());
    const health = new PgDatabaseHealth({ query, end });
    expect(await health.check()).toBe('ok');
    expect(query).toHaveBeenCalledWith('SELECT 1');

    query.mockRejectedValueOnce(new Error('timeout'));
    expect(await health.check()).toBe('error');

    await health.close();
    expect(end).toHaveBeenCalledTimes(1);
  });
});

describe('createPgPool', () => {
  it('bounds the pool and logs idle-client errors by code only', async () => {
    const destination = createMemoryDestination();
    const logger = createLogger({ level: 'info', destination, timestamp: false });
    const pool = createPgPool('postgres://rc:canary-password@127.0.0.1:1/rc', logger);
    expect(pool.options.max).toBe(10);
    expect(pool.options.connectionTimeoutMillis).toBe(2000);

    pool.emit('error', Object.assign(new Error('boom'), { code: '57P01' }));
    pool.emit('error', new Error('no code'));
    const lines = destination.lines();
    expect(lines[0]).toContain('"code":"57P01"');
    expect(lines[1]).toContain('"code":"unknown"');
    expect(lines.join('\n')).not.toContain('canary-password');
    await pool.end();
  });
});

describe('createContainer', () => {
  it('uses the disabled probe without a database URL', async () => {
    const container = createContainer(loadConfig({ RC_LOG_LEVEL: 'silent' }));
    expect(container.database).toBe(disabledDatabaseHealth);
    expect(await container.database.check()).toBe('disabled');
    await container.database.close();
    expect(container.clock).toBe(systemClock);
    expect(container.drain.isDraining()).toBe(false);
  });

  it('prefers an injected database', () => {
    const db = { orm: {}, migrate: vi.fn(), check: vi.fn(), close: vi.fn() } as unknown as Db;
    const container = createContainer(loadConfig({ RC_LOG_LEVEL: 'silent' }), { db });
    expect(container.db).toBe(db);
    expect(container.database).toBe(db);
  });

  it('wires the pg database when a database URL is configured', async () => {
    const container = createContainer(
      loadConfig({ RC_DATABASE_URL: 'postgres://rc@127.0.0.1:1/rc' }),
      { destination: createMemoryDestination() },
    );
    expect(container.db).toBeDefined();
    expect(container.database).toBe(container.db);
    expect(await container.database.check()).toBe('error');
    await container.database.close();
  });
});

describe('systemClock', () => {
  it('returns epoch milliseconds', () => {
    expect(systemClock.now()).toBeGreaterThan(1_700_000_000_000);
  });
});
