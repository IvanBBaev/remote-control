import { fromHex } from '@remote-control/crypto';
import { and, eq, gt, lte } from 'drizzle-orm';

import { verifiedDecisions, webauthnChallenges } from '../db/schema.js';
import type { ChallengeLedger, PendingChallenge } from '../ports/challenge-ledger.js';
import type { RelayDatabase } from '../ports/db.js';

const date = (ms: number) => new Date(ms);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

type ChallengeRow = typeof webauthnChallenges.$inferSelect;

function columnsOf(pending: PendingChallenge) {
  const none = {
    userId: null,
    deviceId: null,
    inviteId: null,
    webauthnUserId: null,
    displayName: null,
    recoveryCodeId: null,
    decisionHash: null,
  };
  switch (pending.kind) {
    case 'register':
      return {
        ...none,
        inviteId: pending.inviteId,
        webauthnUserId: pending.webauthnUserId,
        displayName: pending.displayName,
      };
    case 'login':
      return none;
    case 'recovery':
      return { ...none, userId: pending.userId, recoveryCodeId: pending.recoveryCodeId };
    case 'decision':
      return {
        ...none,
        userId: pending.userId,
        deviceId: pending.deviceId,
        decisionHash: fromHex(pending.decisionHash),
      };
  }
}

/** A row back to its challenge; `undefined` if a required column is missing. */
function pendingOf(row: ChallengeRow): PendingChallenge | undefined {
  switch (row.kind) {
    case 'register':
      return row.inviteId !== null && row.webauthnUserId !== null
        ? {
            kind: 'register',
            inviteId: row.inviteId,
            webauthnUserId: row.webauthnUserId,
            displayName: row.displayName,
          }
        : undefined;
    case 'login':
      return { kind: 'login' };
    case 'recovery':
      return row.userId !== null && row.recoveryCodeId !== null
        ? { kind: 'recovery', userId: row.userId, recoveryCodeId: row.recoveryCodeId }
        : undefined;
    case 'decision':
      return row.userId !== null && row.deviceId !== null && row.decisionHash !== null
        ? {
            kind: 'decision',
            userId: row.userId,
            deviceId: row.deviceId,
            decisionHash: hex(row.decisionHash),
          }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * The {@link ChallengeLedger} over drizzle, shared by every replica on one database
 * (ADR 0016). Single use rests on row-level atomicity: `take` is a `DELETE … RETURNING`
 * and `markVerified` an upsert that only overwrites an expired hash. Expired rows are
 * swept on write. Timestamps come from the Clock port, never `now()`.
 */
export function createDrizzleChallengeLedger(orm: RelayDatabase): ChallengeLedger {
  return {
    async put(key, pending, expiresAt, now) {
      await orm.delete(webauthnChallenges).where(lte(webauthnChallenges.expiresAt, date(now)));
      const row = { kind: pending.kind, ...columnsOf(pending), expiresAt: date(expiresAt) };
      await orm
        .insert(webauthnChallenges)
        .values({ key, ...row })
        .onConflictDoUpdate({ target: webauthnChallenges.key, set: row });
    },

    async take(key, now) {
      const [row] = await orm
        .delete(webauthnChallenges)
        .where(eq(webauthnChallenges.key, key))
        .returning();
      return row !== undefined && now < row.expiresAt.getTime() ? pendingOf(row) : undefined;
    },

    async usage(decisionHash, now) {
      const [row] = await orm
        .select({ usedUntil: verifiedDecisions.usedUntil })
        .from(verifiedDecisions)
        .where(eq(verifiedDecisions.decisionHash, fromHex(decisionHash)));
      return row !== undefined && now < row.usedUntil.getTime() ? 'used' : 'free';
    },

    async markVerified(verified, now) {
      const hash = fromHex(verified.decisionHash);
      await orm.delete(verifiedDecisions).where(lte(verifiedDecisions.usedUntil, date(now)));
      const values = {
        userId: verified.userId,
        deviceId: verified.deviceId,
        usedUntil: date(verified.usedUntil),
        verifiedUntil: date(verified.verifiedUntil),
      };
      const won = await orm
        .insert(verifiedDecisions)
        .values({ decisionHash: hash, ...values })
        .onConflictDoUpdate({
          target: verifiedDecisions.decisionHash,
          set: values,
          setWhere: lte(verifiedDecisions.usedUntil, date(now)),
        })
        .returning({ decisionHash: verifiedDecisions.decisionHash });
      return won.length === 1;
    },

    async isVerified(userId, deviceId, decisionHash, now) {
      const rows = await orm
        .select({ userId: verifiedDecisions.userId })
        .from(verifiedDecisions)
        .where(live(userId, deviceId, decisionHash, now));
      return rows.length === 1;
    },

    async consume(userId, deviceId, decisionHash, now) {
      const spent = await orm
        .update(verifiedDecisions)
        .set({ verifiedUntil: null })
        .where(live(userId, deviceId, decisionHash, now))
        .returning({ userId: verifiedDecisions.userId });
      return spent.length === 1;
    },
  };
}

function live(userId: string, deviceId: string, decisionHash: string, now: number) {
  return and(
    eq(verifiedDecisions.decisionHash, fromHex(decisionHash)),
    eq(verifiedDecisions.userId, userId),
    eq(verifiedDecisions.deviceId, deviceId),
    gt(verifiedDecisions.verifiedUntil, date(now)),
  );
}
