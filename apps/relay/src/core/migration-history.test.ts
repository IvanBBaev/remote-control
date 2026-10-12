import { describe, expect, it } from 'vitest';

import { MigrationHistoryError, verifyMigrationHistory } from './migration-history.js';

const m1 = { createdAt: 100, hash: 'a' };
const m2 = { createdAt: 200, hash: 'b' };

describe('verifyMigrationHistory', () => {
  it('accepts a fresh database, a partial history and a database that is ahead', () => {
    expect(() => verifyMigrationHistory([m1, m2], [])).not.toThrow();
    expect(() => verifyMigrationHistory([m1, m2], [m1])).not.toThrow();
    expect(() => verifyMigrationHistory([m1, m2], [m1, m2])).not.toThrow();
    expect(() =>
      verifyMigrationHistory([m1], [m1, m2, { createdAt: 300, hash: 'c' }]),
    ).not.toThrow();
  });

  it('refuses an applied migration whose SQL changed', () => {
    expect(() => verifyMigrationHistory([m1, { ...m2, hash: 'x' }], [m1, m2])).toThrow(
      MigrationHistoryError,
    );
    expect(() => verifyMigrationHistory([{ ...m1, hash: 'x' }], [m1])).toThrow(/changed/);
  });

  it('refuses a never-applied migration older than the newest applied one', () => {
    const inserted = { createdAt: 150, hash: 'i' };
    expect(() => verifyMigrationHistory([m1, inserted, m2], [m1, m2])).toThrow(/older/);
    expect(() => verifyMigrationHistory([m1, m2], [m2])).toThrow(MigrationHistoryError);
  });
});
