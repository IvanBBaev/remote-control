import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MIGRATIONS_DIR } from '../package-paths.js';
import type { ChallengeLedger, PendingChallenge } from '../ports/challenge-ledger.js';
import { createDrizzleChallengeLedger } from './drizzle-challenge-ledger.js';
import { createPgliteDb } from './pglite-db.js';

const HASH = 'ab'.repeat(32);
const NOW = 1_800_000_000_000;
const verified = (overrides: { usedUntil?: number; verifiedUntil?: number } = {}) => ({
  userId: 'u1',
  deviceId: 'p1',
  decisionHash: HASH,
  usedUntil: NOW + 600_000,
  verifiedUntil: NOW + 300_000,
  ...overrides,
});

describe('createDrizzleChallengeLedger (ADR 0016)', () => {
  const client = new PGlite();
  // Two replicas: separate ledgers over one database.
  let a: ChallengeLedger;
  let b: ChallengeLedger;
  let capped: ChallengeLedger;

  beforeAll(async () => {
    const db = createPgliteDb(client, { migrationsFolder: MIGRATIONS_DIR });
    await db.migrate();
    a = createDrizzleChallengeLedger(db.orm);
    b = createDrizzleChallengeLedger(db.orm);
    capped = createDrizzleChallengeLedger(db.orm, 2);
  });

  beforeEach(async () => {
    await client.exec('DELETE FROM webauthn_challenges; DELETE FROM verified_decisions;');
  });

  afterAll(() => client.close());

  it('hands each kind of challenge to the other replica once, intact', async () => {
    const challenges: PendingChallenge[] = [
      { kind: 'register', inviteId: 'i1', webauthnUserId: 'w1', displayName: null },
      { kind: 'register', inviteId: 'i2', webauthnUserId: 'w2', displayName: 'Ivan' },
      { kind: 'login' },
      { kind: 'recovery', userId: 'u1', recoveryCodeId: 'r1' },
      { kind: 'decision', userId: 'u1', deviceId: 'p1', decisionHash: HASH },
    ];
    for (const [i, pending] of challenges.entries()) {
      await a.put(`k${String(i)}`, pending, NOW + 60_000, NOW);
    }
    for (const [i, pending] of challenges.entries()) {
      expect(await b.take(`k${String(i)}`, NOW)).toEqual(pending);
      expect(await a.take(`k${String(i)}`, NOW)).toBeUndefined();
    }
  });

  it('refuses an expired challenge and sweeps expired rows on write', async () => {
    await a.put('old', { kind: 'login' }, NOW + 1_000, NOW);
    expect(await b.take('old', NOW + 1_000)).toBeUndefined();

    await a.put('stale', { kind: 'login' }, NOW + 1_000, NOW);
    await b.put('fresh', { kind: 'login' }, NOW + 9_000, NOW + 2_000);
    const keys = await client.query<{ key: string }>('SELECT key FROM webauthn_challenges');
    expect(keys.rows).toEqual([{ key: 'fresh' }]);
  });

  it('overwrites a challenge stored again under the same key', async () => {
    await a.put('k', { kind: 'login' }, NOW + 1_000, NOW);
    await b.put('k', { kind: 'recovery', userId: 'u1', recoveryCodeId: 'r1' }, NOW + 1_000, NOW);
    expect(await a.take('k', NOW)).toEqual({
      kind: 'recovery',
      userId: 'u1',
      recoveryCodeId: 'r1',
    });
  });

  it('drops a row that lacks the columns its kind needs', async () => {
    const expires = new Date(NOW + 60_000).toISOString();
    for (const kind of ['register', 'recovery', 'decision']) {
      await client.query(
        'INSERT INTO webauthn_challenges (key, kind, expires_at) VALUES ($1, $2, $3)',
        [kind, kind, expires],
      );
      expect(await a.take(kind, NOW)).toBeUndefined();
    }
  });

  it('lets exactly one replica verify a hash, and remembers it as used', async () => {
    expect(await a.usage(HASH, NOW)).toBe('free');
    const results = await Promise.all([
      a.markVerified(verified(), NOW),
      b.markVerified({ ...verified(), deviceId: 'p2' }, NOW),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await b.usage(HASH, NOW)).toBe('used');
    expect(await b.usage(HASH.toUpperCase(), NOW + 600_000)).toBe('free');
  });

  it('admits the verifying phone on any replica until the window ends or it is spent', async () => {
    await a.markVerified(verified(), NOW);
    expect(await b.isVerified('u1', 'p1', HASH, NOW)).toBe(true);
    expect(await b.isVerified('u1', 'p2', HASH, NOW)).toBe(false);
    expect(await b.isVerified('u2', 'p1', HASH, NOW)).toBe(false);
    expect(await b.isVerified('u1', 'p1', HASH, NOW + 300_000)).toBe(false);

    expect(await b.consume('u1', 'p2', HASH, NOW)).toBe(false);
    const spent = await Promise.all([
      a.consume('u1', 'p1', HASH, NOW),
      b.consume('u1', 'p1', HASH, NOW),
    ]);
    expect(spent.filter(Boolean)).toHaveLength(1);
    expect(await a.isVerified('u1', 'p1', HASH, NOW)).toBe(false);
    // Spent, but still inside its replay window.
    expect(await a.usage(HASH, NOW)).toBe('used');
    expect(await a.markVerified(verified(), NOW)).toBe(false);
  });

  it('verifies a hash again once its replay window has passed', async () => {
    await a.markVerified(verified(), NOW);
    const later = NOW + 600_000;
    expect(
      await b.markVerified(
        verified({ usedUntil: later + 600_000, verifiedUntil: later + 300_000 }),
        later,
      ),
    ).toBe(true);
    expect(await a.isVerified('u1', 'p1', HASH, later)).toBe(true);
  });

  describe('when full', () => {
    it('drops the challenge closest to expiry to make room', async () => {
      await capped.put('soon', { kind: 'login' }, NOW + 1_000, NOW);
      await capped.put('later', { kind: 'login' }, NOW + 9_000, NOW);
      await capped.put('new', { kind: 'login' }, NOW + 5_000, NOW);
      const keys = await client.query<{ key: string }>(
        'SELECT key FROM webauthn_challenges ORDER BY key',
      );
      expect(keys.rows).toEqual([{ key: 'later' }, { key: 'new' }]);
      expect(await capped.take('soon', NOW)).toBeUndefined();
    });

    it('answers busy and refuses a new hash while the table holds only live hashes', async () => {
      const hash = (n: number) => String(n).padStart(2, '0').repeat(32);
      expect(await capped.markVerified({ ...verified(), decisionHash: hash(1) }, NOW)).toBe(true);
      expect(await capped.markVerified({ ...verified(), decisionHash: hash(2) }, NOW)).toBe(true);
      expect(await capped.usage(hash(3), NOW)).toBe('busy');
      expect(await capped.usage(hash(1), NOW)).toBe('used');
      expect(await capped.markVerified({ ...verified(), decisionHash: hash(3) }, NOW)).toBe(false);

      const later = NOW + 600_000;
      expect(await capped.usage(hash(3), later)).toBe('free');
      expect(
        await capped.markVerified(
          verified({ usedUntil: later + 600_000, verifiedUntil: later + 300_000 }),
          later,
        ),
      ).toBe(true);
    });
  });
});
