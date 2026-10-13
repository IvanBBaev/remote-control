import { digestCanonical } from './digest.js';
import { toBase64Url, toHex } from './encoding.js';

/** What the phone signs with UV to delete its account (M1-10, 02 §5.9). */
function deletion(userId: string): { readonly action: 'delete_account'; readonly userId: string } {
  return { action: 'delete_account', userId };
}

/**
 * Hex SHA-256 of `{"action":"delete_account","userId":…}`: the hash the relay's step-up
 * verification (D7) must have seen from the account's own phone before it deletes the
 * account. Its shape is no canonical decision, so it can never pass as one.
 */
export async function accountDeletionHash(userId: string): Promise<string> {
  return toHex(await digestCanonical(deletion(userId)));
}

/** The WebAuthn challenge for {@link accountDeletionHash}: base64url of the same 32 bytes. */
export async function accountDeletionChallenge(userId: string): Promise<string> {
  return toBase64Url(await digestCanonical(deletion(userId)));
}
