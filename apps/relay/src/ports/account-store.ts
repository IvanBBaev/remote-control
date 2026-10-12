/** Times are Unix epoch milliseconds from the Clock port; the adapter maps them to `timestamptz`. */

/** A passkey as verified at registration (fields as `@simplewebauthn/server` returns them). */
export interface NewPasskey {
  readonly id: string;
  readonly publicKey: Uint8Array;
  readonly counter: number;
  readonly transports: readonly string[] | undefined;
  readonly deviceType: 'singleDevice' | 'multiDevice';
  readonly backedUp: boolean;
}

export interface StoredPasskey {
  readonly id: string;
  readonly userId: string;
  readonly webauthnUserId: string;
  readonly publicKey: Uint8Array;
  readonly counter: number;
  readonly transports: readonly string[] | undefined;
}

export interface NewSession {
  readonly tokenHash: Uint8Array;
  readonly expiresAt: number;
}

export interface StoredSession {
  readonly id: string;
  readonly userId: string;
  readonly lastSeenAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
}

export interface NewRecoveryCode {
  readonly locator: string;
  /** Encoded scrypt hash of the secret part. */
  readonly codeHash: string;
}

export interface StoredRecoveryCode {
  readonly id: string;
  readonly userId: string;
  readonly codeHash: string;
  readonly usedAt: number | null;
}

export interface NewAccount {
  readonly inviteId: string;
  readonly webauthnUserId: string;
  readonly displayName: string | null;
  readonly passkey: NewPasskey;
  readonly recoveryCode: NewRecoveryCode;
  readonly session: NewSession;
  readonly now: number;
}

export interface Login {
  readonly userId: string;
  readonly credentialId: string;
  readonly newCounter: number;
  readonly backedUp: boolean;
  readonly session: NewSession;
  readonly now: number;
}

export interface Recovery {
  readonly userId: string;
  readonly recoveryCodeId: string;
  readonly passkey: NewPasskey;
  readonly recoveryCode: NewRecoveryCode;
  readonly session: NewSession;
  readonly now: number;
}

/**
 * Accounts, passkeys, recovery codes, invite codes and login sessions (D8). Every
 * multi-row change is one transaction that also writes its `audit_log` row (event,
 * user, time — no bodies, D19).
 */
export interface AccountStore {
  /** An unused, unexpired invite with this code hash. */
  findUsableInvite(codeHash: Uint8Array, now: number): Promise<{ readonly id: string } | undefined>;
  /** Consumes the invite and creates user, passkey, recovery code and session; `null` if the invite was taken meanwhile. */
  createAccount(account: NewAccount): Promise<{ readonly userId: string } | null>;
  findPasskey(credentialId: string): Promise<StoredPasskey | undefined>;
  listPasskeyIds(userId: string): Promise<string[]>;
  findUser(
    userId: string,
  ): Promise<{ readonly webauthnUserId: string; readonly displayName: string | null } | undefined>;
  recordLogin(login: Login): Promise<void>;
  findRecoveryCode(locator: string): Promise<StoredRecoveryCode | undefined>;
  /** Consumes the code, adds the passkey, rotates the code, revokes every other session; `false` if the code was used meanwhile. */
  recoverAccount(recovery: Recovery): Promise<boolean>;
  findSession(tokenHash: Uint8Array): Promise<StoredSession | undefined>;
  touchSession(sessionId: string, now: number): Promise<void>;
  revokeSession(sessionId: string, userId: string, now: number): Promise<void>;
  createInvites(codeHashes: readonly Uint8Array[], expiresAt: number, now: number): Promise<void>;
}
