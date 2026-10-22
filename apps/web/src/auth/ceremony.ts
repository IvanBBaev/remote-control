import type { CeremonyFailure } from '@remote-control/phone-core/auth/results';

import { OfflineError, RelayError } from './relay-api.js';

export type { CeremonyFailure } from '@remote-control/phone-core/auth/results';

/**
 * `navigator.credentials` rejects with `NotAllowedError` when the user cancels or the
 * sheet times out, and with `AbortError` when a newer ceremony aborts this one (the
 * button login aborts the pending autofill one). `@simplewebauthn/browser` keeps the
 * DOMException name on its `WebAuthnError`; a bare DOMException counts too.
 */
export function isCancelled(error: unknown): boolean {
  const named = error instanceof Error || error instanceof DOMException;
  return named && (error.name === 'NotAllowedError' || error.name === 'AbortError');
}

export function classifyFailure(error: unknown): CeremonyFailure {
  if (isCancelled(error)) return 'cancelled';
  if (error instanceof OfflineError) return 'offline';
  if (error instanceof RelayError) {
    return error.status === 429 ? 'rate_limited' : { relay: error.reason };
  }
  return 'failed';
}
