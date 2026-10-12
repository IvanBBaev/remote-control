import { EventEmitter } from 'node:events';

import { PGlite } from '@electric-sql/pglite';
import { createMemoryDestination } from '@remote-control/log';
import { describe, expect, it, vi } from 'vitest';

import { createPgliteDb } from './adapters/pglite-db.js';
import { startServer } from './main.js';
import { MIGRATIONS_DIR } from './package-paths.js';
import type { Db } from './ports/db.js';

describe('startServer', () => {
  it('listens, serves /health and drains to exit 0 on SIGTERM', async () => {
    const signals = new EventEmitter();
    const exit = vi.fn<(code: number) => void>();
    const destination = createMemoryDestination();
    const { app, shutdown } = await startServer({
      env: { RC_HOST: '127.0.0.1', RC_PORT: '0', RC_PUBLIC_DIR: '/nonexistent-rc-public' },
      signals,
      exit,
      destination,
    });

    const address = app.server.address();
    expect(typeof address === 'object' && address !== null && address.port > 0).toBe(true);
    const health = await app.inject('/health');
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok', db: 'disabled', commit: null });
    expect((await app.inject('/api/version')).json()).toMatchObject({ version: '0.0.0' });

    signals.emit('SIGTERM');
    await shutdown('SIGTERM');
    expect(exit).toHaveBeenCalledWith(0);
    expect(destination.lines().some((line) => line.includes('"event":"shutdown_complete"'))).toBe(
      true,
    );
  });

  it('rejects an invalid environment before listening', async () => {
    await expect(
      startServer({ env: { RC_PORT: 'nope' }, signals: new EventEmitter(), exit: vi.fn() }),
    ).rejects.toThrow(/RC_PORT/);
  });

  it('migrates the database before listening and reports it on /health', async () => {
    const client = new PGlite();
    const destination = createMemoryDestination();
    const { app } = await startServer({
      env: { RC_HOST: '127.0.0.1', RC_PORT: '0', RC_PUBLIC_DIR: '/nonexistent-rc-public' },
      signals: new EventEmitter(),
      exit: vi.fn(),
      destination,
      db: createPgliteDb(client, { migrationsFolder: MIGRATIONS_DIR }),
    });
    expect((await app.inject('/health')).json()).toMatchObject({ db: 'ok' });
    const applied = destination.lines().find((line) => line.includes('"migrations_applied"'));
    expect(applied).toContain('"applied":1');
    const users = await client.query('SELECT 1 FROM users');
    expect(users.rows).toEqual([]);
    await app.close();
    expect(client.closed).toBe(true);
  });

  it('closes the database and fails the boot when migrating fails', async () => {
    const close = vi.fn(() => Promise.resolve());
    const db = {
      orm: {},
      check: vi.fn(),
      close,
      migrate: () => Promise.reject(new Error('lock timeout')),
    } as unknown as Db;
    await expect(
      startServer({
        env: { RC_PORT: '0', RC_LOG_LEVEL: 'silent' },
        signals: new EventEmitter(),
        exit: vi.fn(),
        db,
      }),
    ).rejects.toThrow('lock timeout');
    expect(close).toHaveBeenCalledTimes(1);
  });
});
