import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPgliteDb } from '../adapters/pglite-db.js';
import { MigrationHistoryError } from '../core/migration-history.js';
import { MIGRATIONS_DIR } from '../package-paths.js';
import { MigrationsFixture } from './migrations-fixture.js';
import {
  DEFAULT_LOCK_TIMEOUT_MS,
  MIGRATION_LOCK_KEY,
  migrateWithLock,
  type MigrationSession,
} from './migrator.js';

async function historyRows(client: PGlite): Promise<number> {
  const result = await client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations',
  );
  return result.rows[0]?.n ?? -1;
}

describe('migrateWithLock on PGlite (forward-only, idempotent)', () => {
  let client: PGlite;
  let fixture: MigrationsFixture;

  beforeEach(() => {
    client = new PGlite();
    fixture = new MigrationsFixture(MIGRATIONS_DIR);
  });

  afterEach(async () => {
    if (!client.closed) await client.close();
    fixture.remove();
  });

  it('applies the shipped migrations once and is a no-op on the next boot', async () => {
    const db = createPgliteDb(client, { migrationsFolder: MIGRATIONS_DIR });
    expect(await db.migrate()).toEqual({ applied: 2, total: 2 });
    expect(await db.migrate()).toEqual({ applied: 0, total: 2 });
    expect(await historyRows(client)).toBe(2);
    expect(await db.check()).toBe('ok');
    const users = await client.query('SELECT count(*) FROM users');
    expect(users.rows).toHaveLength(1);
  });

  it('applies only a newly shipped migration', async () => {
    const db = createPgliteDb(client, { migrationsFolder: fixture.folder });
    await db.migrate();
    fixture.add(
      '0001_add_probe',
      fixture.newestWhen() + 1000,
      'CREATE TABLE "probe" ("id" integer PRIMARY KEY);',
    );
    expect(await db.migrate()).toEqual({ applied: 1, total: 3 });
    expect(await db.migrate()).toEqual({ applied: 0, total: 3 });
  });

  it('refuses a migration that was edited after it was applied', async () => {
    const db = createPgliteDb(client, { migrationsFolder: fixture.folder });
    await db.migrate();
    fixture.edit('0000_initial_schema', 'SELECT 1;');
    await expect(db.migrate()).rejects.toBeInstanceOf(MigrationHistoryError);
  });

  it('refuses a migration inserted before the newest applied one', async () => {
    const db = createPgliteDb(client, { migrationsFolder: fixture.folder });
    await db.migrate();
    fixture.add('0001_in_the_past', fixture.newestWhen() - 1000, 'SELECT 1;');
    await expect(db.migrate()).rejects.toThrow(/older than the newest applied/);
    expect(await historyRows(client)).toBe(2);
  });

  it('rolls back a failing migration and releases the lock', async () => {
    const db = createPgliteDb(client, { migrationsFolder: fixture.folder });
    await db.migrate();
    fixture.add(
      '0001_broken',
      fixture.newestWhen() + 1000,
      'CREATE TABLE "half" ("id" integer);\n--> statement-breakpoint\nSELECT * FROM missing_table;',
    );
    await expect(db.migrate()).rejects.toThrow();
    expect(await historyRows(client)).toBe(2);
    const half = await client.query<{ t: string | null }>("SELECT to_regclass('half') AS t");
    expect(half.rows[0]?.t).toBeNull();
    const locks = await client.query("SELECT 1 FROM pg_locks WHERE locktype = 'advisory'");
    expect(locks.rows).toHaveLength(0);
  });

  it('reports error from check once closed', async () => {
    const db = createPgliteDb(client, { migrationsFolder: MIGRATIONS_DIR });
    await db.close();
    expect(await db.check()).toBe('error');
  });
});

describe('migrateWithLock statement order', () => {
  function fakeSession(failApply = false): { session: MigrationSession; log: string[] } {
    const log: string[] = [];
    const session: MigrationSession = {
      query: (text) => {
        log.push(text);
        return Promise.resolve(text.includes('to_regclass') ? [{ present: false }] : []);
      },
      applyPending: () => {
        log.push('APPLY');
        return failApply ? Promise.reject(new Error('boom')) : Promise.resolve();
      },
    };
    return { session, log };
  }

  it('bounds the lock wait, applies under the lock and always unlocks', async () => {
    const { session, log } = fakeSession(true);
    await expect(
      migrateWithLock(session, { migrationsFolder: MIGRATIONS_DIR, lockTimeoutMs: 1500.7 }),
    ).rejects.toThrow('boom');
    expect(log[0]).toBe('SET lock_timeout = 1500');
    expect(log[1]).toBe(`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
    expect(log[2]).toBe('RESET lock_timeout');
    expect(log.indexOf('APPLY')).toBeGreaterThan(2);
    expect(log.at(-1)).toBe(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
  });

  it('uses the default lock timeout', async () => {
    const { session, log } = fakeSession();
    expect(await migrateWithLock(session, { migrationsFolder: MIGRATIONS_DIR })).toEqual({
      applied: 0,
      total: 0,
    });
    expect(log[0]).toBe(`SET lock_timeout = ${DEFAULT_LOCK_TIMEOUT_MS}`);
  });
});
