import type { Clock, Random } from '@remote-control/protocol';

import type { AccountStore } from '../ports/account-store.js';
import { inviteCodeHash, newInviteCode } from './secret-codes.js';

export const MAX_INVITES_PER_RUN = 100;

/** Mints `count` single-use invite codes; only their hashes are stored. Returns the codes. */
export async function mintInvites(
  deps: { readonly store: AccountStore; readonly random: Random; readonly clock: Clock },
  count: number,
  ttlMs: number,
): Promise<string[]> {
  if (!Number.isInteger(count) || count < 1 || count > MAX_INVITES_PER_RUN) {
    throw new RangeError(`count must be an integer between 1 and ${MAX_INVITES_PER_RUN}`);
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError('ttl must be positive');
  const codes = Array.from({ length: count }, () => newInviteCode(deps.random));
  const hashes = await Promise.all(codes.map(async (code) => (await inviteCodeHash(code))!));
  const now = deps.clock.now();
  await deps.store.createInvites(hashes, now + ttlMs, now);
  return codes;
}
