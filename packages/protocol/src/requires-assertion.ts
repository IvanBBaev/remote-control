import type { DecisionKind } from './canonical-decision.js';

/**
 * Whether a decision kind must carry a user-verified WebAuthn assertion bound to its
 * hash (D7: one biometric per Allow/Always/Answer/Instruct/Start, none for Deny).
 */
export function requiresAssertion(kind: DecisionKind): boolean {
  return kind !== 'deny' && kind !== 'terminal';
}
