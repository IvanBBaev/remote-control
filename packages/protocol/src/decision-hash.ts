import type { CanonicalDecision } from './canonical-decision.js';
import { digestCanonical } from './digest.js';
import { toHex } from './encoding.js';

/**
 * Hex SHA-256 of the canonical decision JSON (D7). The input is hashed as given, not
 * validated: validate with `CanonicalDecision` before trusting it.
 */
export async function decisionHash(decision: CanonicalDecision): Promise<string> {
  return toHex(await digestCanonical(decision));
}
