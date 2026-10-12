/**
 * Randomness source. Core code draws random bytes only through this port; the system
 * adapter is the only place allowed to call `crypto.getRandomValues()` (lint-enforced).
 */
export interface Random {
  /** Returns `length` cryptographically secure random bytes. */
  bytes(length: number): Uint8Array;
}
