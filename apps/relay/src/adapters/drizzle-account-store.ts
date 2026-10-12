import { and, eq, gt, isNull } from 'drizzle-orm';

import { auditLog, inviteCodes, passkeys, recoveryCodes, sessions, users } from '../db/schema.js';
import type { AccountStore, NewPasskey } from '../ports/account-store.js';
import type { RelayDatabase } from '../ports/db.js';

/** Audit events written by the account flows (02 §5.6): event, user, time only (D19). */
export type AccountAuditEvent =
  'register' | 'login' | 'recovery' | 'session_revoked' | 'invite_created';

const date = (ms: number) => new Date(ms);
const ms = (value: Date | null) => (value === null ? null : value.getTime());

function passkeyRow(userId: string, passkey: NewPasskey, now: number) {
  return {
    id: passkey.id,
    userId,
    publicKey: passkey.publicKey,
    counter: passkey.counter,
    transports: passkey.transports === undefined ? null : [...passkey.transports],
    deviceType: passkey.deviceType,
    backedUp: passkey.backedUp,
    createdAt: date(now),
    lastUsedAt: date(now),
  };
}

/** The `AccountStore` over drizzle; all timestamps come from the Clock port, never `now()`. */
export function createDrizzleAccountStore(orm: RelayDatabase): AccountStore {
  return {
    async findUsableInvite(codeHash, now) {
      const [row] = await orm
        .select({ id: inviteCodes.id })
        .from(inviteCodes)
        .where(
          and(
            eq(inviteCodes.codeHash, codeHash),
            isNull(inviteCodes.usedAt),
            gt(inviteCodes.expiresAt, date(now)),
          ),
        );
      return row;
    },

    createAccount(account) {
      return orm.transaction(async (tx) => {
        const consumed = await tx
          .update(inviteCodes)
          .set({ usedAt: date(account.now) })
          .where(
            and(
              eq(inviteCodes.id, account.inviteId),
              isNull(inviteCodes.usedAt),
              gt(inviteCodes.expiresAt, date(account.now)),
            ),
          )
          .returning({ id: inviteCodes.id });
        if (consumed.length === 0) return null;
        const [user] = await tx
          .insert(users)
          .values({
            webauthnUserId: account.webauthnUserId,
            displayName: account.displayName,
            createdAt: date(account.now),
          })
          .returning({ id: users.id });
        const userId = user!.id;
        await tx
          .update(inviteCodes)
          .set({ usedByUserId: userId })
          .where(eq(inviteCodes.id, account.inviteId));
        await tx.insert(passkeys).values(passkeyRow(userId, account.passkey, account.now));
        await tx.insert(recoveryCodes).values({
          userId,
          locator: account.recoveryCode.locator,
          codeHash: account.recoveryCode.codeHash,
          createdAt: date(account.now),
        });
        await tx.insert(sessions).values({
          userId,
          tokenHash: account.session.tokenHash,
          createdAt: date(account.now),
          lastSeenAt: date(account.now),
          expiresAt: date(account.session.expiresAt),
        });
        await tx.insert(auditLog).values({ userId, event: 'register', at: date(account.now) });
        return { userId };
      });
    },

    async findPasskey(credentialId) {
      const [row] = await orm
        .select({
          id: passkeys.id,
          userId: passkeys.userId,
          webauthnUserId: users.webauthnUserId,
          publicKey: passkeys.publicKey,
          counter: passkeys.counter,
          transports: passkeys.transports,
        })
        .from(passkeys)
        .innerJoin(users, eq(users.id, passkeys.userId))
        .where(eq(passkeys.id, credentialId));
      if (row === undefined) return undefined;
      return { ...row, transports: row.transports ?? undefined };
    },

    async listPasskeyIds(userId) {
      const rows = await orm
        .select({ id: passkeys.id })
        .from(passkeys)
        .where(eq(passkeys.userId, userId));
      return rows.map((row) => row.id);
    },

    async findUser(userId) {
      const [row] = await orm
        .select({ webauthnUserId: users.webauthnUserId, displayName: users.displayName })
        .from(users)
        .where(eq(users.id, userId));
      return row;
    },

    async recordLogin(login) {
      await orm.transaction(async (tx) => {
        await tx
          .update(passkeys)
          .set({
            counter: login.newCounter,
            backedUp: login.backedUp,
            lastUsedAt: date(login.now),
          })
          .where(eq(passkeys.id, login.credentialId));
        await tx.insert(sessions).values({
          userId: login.userId,
          tokenHash: login.session.tokenHash,
          createdAt: date(login.now),
          lastSeenAt: date(login.now),
          expiresAt: date(login.session.expiresAt),
        });
        await tx
          .insert(auditLog)
          .values({ userId: login.userId, event: 'login', at: date(login.now) });
      });
    },

    async recordPasskeyUse(credentialId, newCounter, backedUp, now) {
      await orm
        .update(passkeys)
        .set({ counter: newCounter, backedUp, lastUsedAt: date(now) })
        .where(eq(passkeys.id, credentialId));
    },

    async findRecoveryCode(locator) {
      const [row] = await orm
        .select({
          id: recoveryCodes.id,
          userId: recoveryCodes.userId,
          codeHash: recoveryCodes.codeHash,
          usedAt: recoveryCodes.usedAt,
        })
        .from(recoveryCodes)
        .where(eq(recoveryCodes.locator, locator));
      return row === undefined ? undefined : { ...row, usedAt: ms(row.usedAt) };
    },

    recoverAccount(recovery) {
      return orm.transaction(async (tx) => {
        const consumed = await tx
          .update(recoveryCodes)
          .set({ usedAt: date(recovery.now) })
          .where(
            and(
              eq(recoveryCodes.id, recovery.recoveryCodeId),
              eq(recoveryCodes.userId, recovery.userId),
              isNull(recoveryCodes.usedAt),
            ),
          )
          .returning({ id: recoveryCodes.id });
        if (consumed.length === 0) return false;
        await tx
          .insert(passkeys)
          .values(passkeyRow(recovery.userId, recovery.passkey, recovery.now));
        await tx.insert(recoveryCodes).values({
          userId: recovery.userId,
          locator: recovery.recoveryCode.locator,
          codeHash: recovery.recoveryCode.codeHash,
          createdAt: date(recovery.now),
        });
        // Whoever lost the passkey may also have lost a logged-in browser: end them all.
        await tx
          .update(sessions)
          .set({ revokedAt: date(recovery.now) })
          .where(and(eq(sessions.userId, recovery.userId), isNull(sessions.revokedAt)));
        await tx.insert(sessions).values({
          userId: recovery.userId,
          tokenHash: recovery.session.tokenHash,
          createdAt: date(recovery.now),
          lastSeenAt: date(recovery.now),
          expiresAt: date(recovery.session.expiresAt),
        });
        await tx
          .insert(auditLog)
          .values({ userId: recovery.userId, event: 'recovery', at: date(recovery.now) });
        return true;
      });
    },

    async findSession(tokenHash) {
      const [row] = await orm
        .select({
          id: sessions.id,
          userId: sessions.userId,
          lastSeenAt: sessions.lastSeenAt,
          expiresAt: sessions.expiresAt,
          revokedAt: sessions.revokedAt,
        })
        .from(sessions)
        .where(eq(sessions.tokenHash, tokenHash));
      if (row === undefined) return undefined;
      return {
        id: row.id,
        userId: row.userId,
        lastSeenAt: row.lastSeenAt.getTime(),
        expiresAt: row.expiresAt.getTime(),
        revokedAt: ms(row.revokedAt),
      };
    },

    async touchSession(sessionId, now) {
      await orm
        .update(sessions)
        .set({ lastSeenAt: date(now) })
        .where(eq(sessions.id, sessionId));
    },

    async revokeSession(sessionId, userId, now) {
      await orm.transaction(async (tx) => {
        await tx
          .update(sessions)
          .set({ revokedAt: date(now) })
          .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
        await tx.insert(auditLog).values({ userId, event: 'session_revoked', at: date(now) });
      });
    },

    async createInvites(codeHashes, expiresAt, now) {
      await orm.transaction(async (tx) => {
        await tx.insert(inviteCodes).values(
          codeHashes.map((codeHash) => ({
            codeHash,
            createdAt: date(now),
            expiresAt: date(expiresAt),
          })),
        );
        await tx
          .insert(auditLog)
          .values(codeHashes.map(() => ({ userId: null, event: 'invite_created', at: date(now) })));
      });
    },
  };
}
