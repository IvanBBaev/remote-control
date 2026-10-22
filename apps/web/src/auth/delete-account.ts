import { accountDeletionChallenge, accountDeletionHash } from '@remote-control/protocol';
import type { DeleteAccountResult } from '@remote-control/phone-core/auth/results';
import { startAuthentication } from '@simplewebauthn/browser';

import { classifyFailure } from './ceremony.js';
import type { RelayApi } from './relay-api.js';

export type { DeleteAccountResult } from '@remote-control/phone-core/auth/results';

class ChallengeMismatch extends Error {}

/**
 * Deletes the account (M1-10, 02 §5.9) behind a user-verified passkey assertion over
 * `accountDeletionHash(userId)`, through the same challenge/verify endpoints as a
 * decision (D7). As there, the phone checks the relay handed it the challenge for this
 * account's deletion before it asks the authenticator, and forces UV. Call it from the
 * tap handler, so iOS lets the passkey sheet open.
 */
export async function deleteAccount(
  userId: string,
  api: Pick<RelayApi, 'decisionChallenge' | 'decisionVerify' | 'deleteAccount'>,
): Promise<DeleteAccountResult> {
  const hash = await accountDeletionHash(userId);
  try {
    const options = await api.decisionChallenge(hash);
    if (options.challenge !== (await accountDeletionChallenge(userId))) {
      throw new ChallengeMismatch();
    }
    const response = await startAuthentication({
      optionsJSON: { ...options, userVerification: 'required' },
    });
    const verified = await api.decisionVerify(response);
    if (verified.decisionHash !== hash) throw new ChallengeMismatch();
    await api.deleteAccount();
    return { ok: true };
  } catch (error) {
    if (error instanceof ChallengeMismatch) return { ok: false, failure: 'challenge_mismatch' };
    return { ok: false, failure: classifyFailure(error) };
  }
}
