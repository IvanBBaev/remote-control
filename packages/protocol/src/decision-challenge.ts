import type { CanonicalDecision } from './canonical-decision.js';
import { digestCanonical } from './digest.js';
import { toBase64Url } from './encoding.js';

/** The WebAuthn challenge for a decision: `base64url(SHA-256(canonical decision))` (D7). */
export async function decisionChallenge(decision: CanonicalDecision): Promise<string> {
  return toBase64Url(await digestCanonical(decision));
}
