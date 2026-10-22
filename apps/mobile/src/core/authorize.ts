import { decisionHash, requiresAssertion } from '@remote-control/protocol';
import type { CanonicalDecision } from '@remote-control/protocol';
import type {
  AssertDecisionResult,
  DeleteAccountResult,
} from '@remote-control/phone-core/auth/results';

/**
 * The app's decision binding until it has its own passkey (M4-04): kinds that need no
 * assertion (Deny, "Reply in terminal", D7) go out with their hash; every other kind is
 * refused here, so nothing that needs a passkey is ever sent without one.
 */
export async function authorizeWithoutPasskey(
  decision: CanonicalDecision,
): Promise<AssertDecisionResult> {
  if (requiresAssertion(decision.kind)) return { ok: false, failure: 'cancelled' };
  return { ok: true, decisionHash: await decisionHash(decision), asserted: false };
}

/** Account deletion needs a passkey assertion (M1-10), which arrives with M4-04. */
export function deleteAccountWithoutPasskey(): Promise<DeleteAccountResult> {
  return Promise.resolve({ ok: false, failure: 'cancelled' });
}
