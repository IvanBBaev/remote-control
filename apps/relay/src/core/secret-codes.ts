import { sha256, utf8 } from '@remote-control/crypto';
import type { Random } from '@remote-control/protocol';

import { crockfordBase32 } from './crockford-base32.js';

/** 16 random bytes → 26 Crockford characters. */
const SECRET_BYTES = 16;
const SECRET_LENGTH = 26;
/** 5 random bytes → 8 characters; finds the recovery-code row, protects nothing. */
const LOCATOR_BYTES = 5;
const LOCATOR_LENGTH = 8;

/** A fresh 128-bit invite code (D8, 02 §5.7), as shown to the admin. */
export function newInviteCode(random: Random): string {
  return crockfordBase32.encode(random.bytes(SECRET_BYTES));
}

/**
 * The stored form of an invite code: SHA-256 of its canonical text. A plain hash is
 * enough for a 128-bit random code, and it can be looked up directly. `null` when the
 * text cannot be an invite code.
 */
export async function inviteCodeHash(code: string): Promise<Uint8Array | null> {
  const canonical = crockfordBase32.normalize(code);
  if (canonical?.length !== SECRET_LENGTH) return null;
  return sha256(utf8(canonical));
}

export interface RecoveryCode {
  /** What the user writes down: `LOCATOR-SECRET`. */
  readonly display: string;
  readonly locator: string;
  readonly secret: string;
}

/** A fresh recovery code: a non-secret locator plus a 128-bit secret (02 §5.5). */
export function newRecoveryCode(random: Random): RecoveryCode {
  const locator = crockfordBase32.encode(random.bytes(LOCATOR_BYTES));
  const secret = crockfordBase32.encode(random.bytes(SECRET_BYTES));
  return { display: `${locator}-${secret}`, locator, secret };
}

/** Splits a typed recovery code; `null` when it has the wrong shape. */
export function parseRecoveryCode(text: string): { locator: string; secret: string } | null {
  const canonical = crockfordBase32.normalize(text);
  if (canonical?.length !== LOCATOR_LENGTH + SECRET_LENGTH) return null;
  return { locator: canonical.slice(0, LOCATOR_LENGTH), secret: canonical.slice(LOCATOR_LENGTH) };
}
