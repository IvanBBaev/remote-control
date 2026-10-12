import { EventEmitter } from 'node:events';

import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { migratePostgres } from '../adapters/pg-db.js';
import { startServer } from '../main.js';
import { MIGRATIONS_DIR } from '../package-paths.js';
import { MigrationsFixture } from './migrations-fixture.js';
import { MIGRATION_LOCK_KEY } from './migrator.js';
import { FORBIDDEN_COLUMNS, RELAY_TABLES, introspectSchema } from './schema-introspection.js';

// Real Postgres (vitest project `pg-real`, CI job from M0-25). PGlite is a single
// connection, so the advisory-lock contention can only be proven here.
const url = process.env['RC_TEST_DATABASE_URL'];

async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function resetDatabase(): Promise<void> {
  await withClient(async (client) => {
    await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
  });
}

async function recordedHashes(): Promise<string[]> {
  return withClient(async (client) => {
    const result = await client.query<{ hash: string }>(
      'SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id',
    );
    return result.rows.map((row) => row.hash);
  });
}

describe.skipIf(url === undefined)('migrations on real Postgres', () => {
  const connectionString = url ?? '';

  beforeEach(resetDatabase);
  afterAll(resetDatabase);

  it('two concurrent migrators apply each migration exactly once', async () => {
    const fixture = new MigrationsFixture(MIGRATIONS_DIR);
    try {
      // A slow second migration widens the window in which both runners overlap.
      fixture.add(
        '0001_slow',
        fixture.newestWhen() + 1000,
        'SELECT pg_sleep(0.5);\n--> statement-breakpoint\nCREATE TABLE "probe" ("id" integer);',
      );
      const reports = await Promise.all(
        [1, 2, 3].map(() =>
          migratePostgres(connectionString, { migrationsFolder: fixture.folder }),
        ),
      );
      expect(reports.map((report) => report.applied).sort()).toEqual([0, 0, 3]);
      expect(reports.every((report) => report.total === 3)).toBe(true);
      const hashes = await recordedHashes();
      expect(hashes).toHaveLength(3);
      expect(new Set(hashes).size).toBe(3);
    } finally {
      fixture.remove();
    }
  });

  it('two concurrent relay boots migrate once and both serve /health', async () => {
    const env = {
      RC_HOST: '127.0.0.1',
      RC_PORT: '0',
      RC_LOG_LEVEL: 'silent',
      RC_PUBLIC_DIR: '/nonexistent-rc-public',
      RC_DATABASE_URL: connectionString,
    };
    const servers = await Promise.all(
      [1, 2].map(() => startServer({ env, signals: new EventEmitter(), exit: vi.fn() })),
    );
    try {
      for (const { app } of servers) {
        expect((await app.inject('/health')).json()).toMatchObject({ db: 'ok' });
      }
      expect(await recordedHashes()).toHaveLength(2);
    } finally {
      await Promise.all(servers.map(({ app }) => app.close()));
    }
  });

  it('waits for a held lock and fails after the lock timeout', async () => {
    await withClient(async (holder) => {
      await holder.query(`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
      await expect(
        migratePostgres(connectionString, { migrationsFolder: MIGRATIONS_DIR, lockTimeoutMs: 300 }),
      ).rejects.toThrow(/lock timeout/);

      const waiting = migratePostgres(connectionString, { migrationsFolder: MIGRATIONS_DIR });
      let settled = false;
      void waiting.finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      await holder.query(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
      expect(await waiting).toEqual({ applied: 2, total: 2 });
    });
  });

  it('leaves no payload-like column in the migrated schema', async () => {
    await migratePostgres(connectionString, { migrationsFolder: MIGRATIONS_DIR });
    const schema = await withClient((client) =>
      introspectSchema((text) =>
        client.query<Record<string, unknown>>(text).then((result) => result.rows),
      ),
    );
    expect(schema.tables).toEqual([...RELAY_TABLES].sort());
    expect(schema.columns.filter((column) => FORBIDDEN_COLUMNS.includes(column.name))).toEqual([]);
    expect(schema.columns.filter((column) => /json/.test(column.type))).toEqual([]);
  });
});
