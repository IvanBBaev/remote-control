import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { PGlite } from '@electric-sql/pglite';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgliteDb } from '../adapters/pglite-db.js';
import { MIGRATIONS_DIR } from '../package-paths.js';
import { MigrationsFixture } from './migrations-fixture.js';
import * as schema from './schema.js';
import { FORBIDDEN_COLUMNS, RELAY_TABLES, introspectSchema } from './schema-introspection.js';

describe('relay schema after migration (invariant I3)', () => {
  const client = new PGlite();

  beforeAll(async () => {
    await createPgliteDb(client, { migrationsFolder: MIGRATIONS_DIR }).migrate();
  });

  afterAll(() => client.close());

  it('has exactly the 02 §5.6 tables, no payload-like column and no json column', async () => {
    const schema = await introspectSchema((text) =>
      client.query<Record<string, unknown>>(text).then((result) => result.rows),
    );
    expect(schema.tables).toEqual([...RELAY_TABLES].sort());
    expect(schema.columns.length).toBeGreaterThan(40);
    expect(schema.columns.filter((column) => FORBIDDEN_COLUMNS.includes(column.name))).toEqual([]);
    expect(schema.columns.filter((column) => /json/.test(column.type))).toEqual([]);
  });
});

describe('TypeScript schema', () => {
  it('declares the same tables, and every foreign key resolves', () => {
    const tables = Object.values(schema)
      .filter((value) => value instanceof PgTable)
      .map((table) => getTableConfig(table));
    expect(tables.map((table) => table.name).sort()).toEqual([...RELAY_TABLES].sort());
    for (const table of tables) {
      for (const foreignKey of table.foreignKeys) {
        expect(RELAY_TABLES).toContain(getTableConfig(foreignKey.reference().foreignTable).name);
      }
    }
  });
});

describe('committed migrations match the TypeScript schema', () => {
  it('drizzle-kit generate finds nothing to migrate', async () => {
    const fixture = new MigrationsFixture(MIGRATIONS_DIR);
    try {
      const before = readdirSync(fixture.folder);
      const packageRoot = dirname(MIGRATIONS_DIR);
      await promisify(execFile)(
        join(packageRoot, 'node_modules', '.bin', 'drizzle-kit'),
        [
          'generate',
          '--dialect=postgresql',
          '--schema=./src/db/schema.ts',
          `--out=${fixture.folder}`,
        ],
        { cwd: packageRoot },
      );
      expect(readdirSync(fixture.folder)).toEqual(before);
    } finally {
      fixture.remove();
    }
  }, 60_000);
});
