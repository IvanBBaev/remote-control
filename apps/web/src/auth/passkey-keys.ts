import { PairedPasskey } from '@remote-control/protocol';

/**
 * The public keys of the passkeys this phone registered, per account (D7 phase 2,
 * M2-03). The phone hands them to a computer inside the authenticated pairing handshake,
 * so the agent can check each decision's assertion itself instead of taking the relay's
 * word. Public keys only: losing them costs the agent-side check, never a secret.
 */
export interface PasskeyKeys {
  list(userId: string): readonly PairedPasskey[];
  add(userId: string, passkey: PairedPasskey): void;
}

const KEYS_KEY = 'rc.auth.passkeys';
/** As many as a pairing hello carries. */
const MAX_PER_ACCOUNT = 16;

const Keys = PairedPasskey.array().max(MAX_PER_ACCOUNT);

/** `localStorage` can be missing or throw (private mode, blocked site data). */
export function storagePasskeyKeys(storage: () => Storage | undefined): PasskeyKeys {
  /** Every account's keys; an entry that does not parse is dropped. */
  function read(): Record<string, PairedPasskey[]> {
    let stored: unknown;
    try {
      stored = JSON.parse(storage()?.getItem(KEYS_KEY) ?? '{}');
    } catch {
      return {};
    }
    if (typeof stored !== 'object' || stored === null) return {};
    const all: Record<string, PairedPasskey[]> = {};
    for (const [userId, keys] of Object.entries(stored)) {
      const parsed = Keys.safeParse(keys);
      if (parsed.success) all[userId] = parsed.data;
    }
    return all;
  }
  return {
    list: (userId) => read()[userId] ?? [],
    add(userId, passkey) {
      const all = read();
      const kept = (all[userId] ?? []).filter((entry) => entry.id !== passkey.id);
      all[userId] = [...kept, passkey].slice(-MAX_PER_ACCOUNT);
      try {
        storage()?.setItem(KEYS_KEY, JSON.stringify(all));
      } catch {
        // Without it this phone pairs as before M2-03: the relay checks its assertions.
      }
    },
  };
}

export function memoryPasskeyKeys(): PasskeyKeys {
  const all = new Map<string, PairedPasskey[]>();
  return {
    list: (userId) => all.get(userId) ?? [],
    add(userId, passkey) {
      const kept = (all.get(userId) ?? []).filter((entry) => entry.id !== passkey.id);
      all.set(userId, [...kept, passkey].slice(-MAX_PER_ACCOUNT));
    },
  };
}
