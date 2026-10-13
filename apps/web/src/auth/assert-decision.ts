import { decisionChallenge, decisionHash, requiresAssertion } from '@remote-control/protocol';
import type { CanonicalDecision, DecisionAssertion } from '@remote-control/protocol';
import { startAuthentication } from '@simplewebauthn/browser';

import { classifyFailure } from './ceremony.js';
import type { CeremonyFailure } from './ceremony.js';
import type { RelayApi } from './relay-api.js';

export type AssertDecisionResult =
  | {
      readonly ok: true;
      /** Goes into the head of the `cls: command` envelope (02 §5.4). */
      readonly decisionHash: string;
      /** `false` for Deny and "Reply in terminal": they need no assertion (D7). */
      readonly asserted: boolean;
      /**
       * The assertion itself, sealed into the decision so the agent checks it without
       * the relay (D7 phase 2, M2-03); absent when `asserted` is `false`.
       */
      readonly assertion?: DecisionAssertion;
    }
  | {
      readonly ok: false;
      readonly failure:
        | CeremonyFailure
        /** The relay's challenge is not this decision's hash: never sign it. */
        | 'challenge_mismatch';
    };

class ChallengeMismatch extends Error {}

/**
 * Binds one decision to one user-verified passkey assertion (D7, 05 Rec-4): the
 * challenge is `base64url(SHA-256(canonical decision))`, so the signature covers exactly
 * what the user tapped. Call it from the tap handler — the relay issues the options on
 * that tap and `navigator.credentials.get` follows at once.
 *
 * The relay holds no authority (I3): the phone checks that the challenge it was handed
 * is the hash of its own decision before it asks the authenticator, and forces
 * `userVerification: "required"` whatever the options say.
 */
export async function assertDecision(
  decision: CanonicalDecision,
  api: Pick<RelayApi, 'decisionChallenge' | 'decisionVerify'>,
): Promise<AssertDecisionResult> {
  const hash = await decisionHash(decision);
  if (!requiresAssertion(decision.kind)) return { ok: true, decisionHash: hash, asserted: false };
  try {
    const options = await api.decisionChallenge(hash);
    if (options.challenge !== (await decisionChallenge(decision))) throw new ChallengeMismatch();
    const response = await startAuthentication({
      optionsJSON: { ...options, userVerification: 'required' },
    });
    const verified = await api.decisionVerify(response);
    if (verified.decisionHash !== hash) throw new ChallengeMismatch();
    const assertion: DecisionAssertion = {
      credentialId: response.id,
      authenticatorData: response.response.authenticatorData,
      clientDataJSON: response.response.clientDataJSON,
      signature: response.response.signature,
    };
    return { ok: true, decisionHash: hash, asserted: true, assertion };
  } catch (error) {
    if (error instanceof ChallengeMismatch) return { ok: false, failure: 'challenge_mismatch' };
    return { ok: false, failure: classifyFailure(error) };
  }
}
