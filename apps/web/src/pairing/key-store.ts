import {
  deriveNotificationKey,
  X25519_KEY_LENGTH,
  x25519KeyPairFromPrivateKey,
} from '@remote-control/crypto';
import type { X25519KeyPair } from '@remote-control/crypto';
import type {
  KeyStore,
  PairedMachine,
  PhoneIdentity,
} from '@remote-control/phone-core/pairing/key-store';
import type { Random } from '@remote-control/protocol';

import {
  committed,
  done,
  IDENTITY,
  isDataCloneError,
  MACHINES,
  openKeyDb,
  PUSH_KEYS,
} from './key-db.js';
import type { StoredPushKey } from './key-db.js';

export type {
  KeyStore,
  PairedMachine,
  PhoneIdentity,
} from '@remote-control/phone-core/pairing/key-store';

const PHONE_KEY = 'phone';

/**
 * The identity as stored. The private key is a non-extractable `CryptoKey`, which
 * IndexedDB stores by structured clone (05 F17): script can use it but never read its
 * bytes. A browser that cannot clone a `CryptoKey` into IndexedDB is refused (RV-SEC-04):
 * the raw seed is never stored, since script on this origin could read it.
 */
interface StoredIdentity {
  readonly deviceId: string | null;
  readonly privateKey: CryptoKey;
  readonly publicKey: Uint8Array<ArrayBuffer>;
}

/** The raw-seed record older builds wrote; upgraded to a `CryptoKey` on load. */
interface LegacySeedIdentity {
  readonly deviceId: string | null;
  readonly seed: Uint8Array;
}

/** This browser cannot keep the phone's private key unreadable to script (RV-SEC-04). */
export class UnsupportedBrowserError extends Error {
  constructor() {
    super(
      'This browser cannot store the phone key safely. Use the remote-control app or a current browser.',
    );
    this.name = 'UnsupportedBrowserError';
  }
}

export interface IndexedDbKeyStoreOptions {
  readonly indexedDB: IDBFactory;
  readonly random: Random;
}

/** The key store on IndexedDB (05 W7). */
export function createIndexedDbKeyStore({ indexedDB, random }: IndexedDbKeyStoreOptions): KeyStore {
  let database: Promise<IDBDatabase> | undefined;
  let identity: Promise<PhoneIdentity> | undefined;
  const db = () => (database ??= openKeyDb(indexedDB));

  async function read<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
    const transaction = (await db()).transaction(store, 'readonly');
    return (await done(transaction.objectStore(store).get(key))) as T | undefined;
  }

  async function write(store: string, run: (objects: IDBObjectStore) => void): Promise<void> {
    const transaction = (await db()).transaction(store, 'readwrite');
    const finished = committed(transaction);
    run(transaction.objectStore(store));
    await finished;
  }

  async function putIdentity(stored: StoredIdentity): Promise<void> {
    await write(IDENTITY, (objects) => {
      objects.put(stored, PHONE_KEY);
    });
  }

  /**
   * Stores the key pair as a `CryptoKey`. A browser that cannot clone one is refused, and
   * whatever identity record exists (a legacy raw seed) is deleted rather than kept.
   */
  async function storeKeyPair(keyPair: X25519KeyPair, deviceId: string | null): Promise<void> {
    try {
      await putIdentity({ ...keyPair, deviceId });
    } catch (error) {
      if (!isDataCloneError(error)) throw error;
      await write(IDENTITY, (objects) => {
        objects.delete(PHONE_KEY);
      });
      throw new UnsupportedBrowserError();
    }
  }

  /**
   * Stores the pairing's decrypt-only notification key for the service worker (D5,
   * M1-06). Callers treat it as best-effort: without a key (a browser that cannot store a
   * `CryptoKey`, a failed derivation) that pairing's pushes stay generic — the raw key
   * bytes are never stored instead.
   */
  async function putPushKey(keyPair: X25519KeyPair, machine: PairedMachine): Promise<void> {
    const key = await deriveNotificationKey(keyPair.privateKey, machine.publicKey, ['decrypt']);
    await write(PUSH_KEYS, (objects) => {
      objects.put({ deviceId: machine.deviceId, key } satisfies StoredPushKey);
    });
  }

  /** Pairings made before M1-06 have no notification key yet; derive the missing ones. */
  async function backfillPushKeys(keyPair: X25519KeyPair): Promise<void> {
    const transaction = (await db()).transaction(PUSH_KEYS, 'readonly');
    const have = new Set((await done(transaction.objectStore(PUSH_KEYS).getAllKeys())) as string[]);
    for (const machine of await list()) {
      if (!have.has(machine.deviceId)) await putPushKey(keyPair, machine).catch(() => undefined);
    }
  }

  async function list(): Promise<PairedMachine[]> {
    const transaction = (await db()).transaction(MACHINES, 'readonly');
    const all = (await done(transaction.objectStore(MACHINES).getAll())) as PairedMachine[];
    // Copied into this realm's `Uint8Array`, so byte comparisons and `instanceof` checks
    // hold whatever structured-clone implementation the store uses.
    return all
      .map((machine) => ({ ...machine, publicKey: new Uint8Array(machine.publicKey) }))
      .sort((a, b) => a.pairedAt - b.pairedAt);
  }

  async function load(): Promise<PhoneIdentity> {
    const stored = await read<StoredIdentity | LegacySeedIdentity>(IDENTITY, PHONE_KEY);
    if (stored !== undefined) {
      let keyPair: X25519KeyPair;
      if ('seed' in stored) {
        keyPair = await x25519KeyPairFromPrivateKey(stored.seed);
        await storeKeyPair(keyPair, stored.deviceId);
      } else {
        keyPair = { privateKey: stored.privateKey, publicKey: new Uint8Array(stored.publicKey) };
      }
      // Best-effort: a pairing without a key only means generic pushes for it.
      await backfillPushKeys(keyPair).catch(() => undefined);
      return { keyPair, deviceId: stored.deviceId };
    }
    const seed = random.bytes(X25519_KEY_LENGTH);
    const keyPair = await x25519KeyPairFromPrivateKey(seed);
    await storeKeyPair(keyPair, null);
    return { keyPair, deviceId: null };
  }

  return {
    identity: () => (identity ??= load()),
    async setDeviceId(deviceId) {
      const current = await (identity ??= load());
      const stored = await read<StoredIdentity>(IDENTITY, PHONE_KEY);
      if (stored === undefined) throw new Error('key store: identity record missing');
      await putIdentity({ ...stored, deviceId });
      identity = Promise.resolve({ ...current, deviceId });
    },
    machines: list,
    async saveMachine(machine) {
      await write(MACHINES, (objects) => {
        objects.put({ ...machine });
      });
      const { keyPair } = await (identity ??= load());
      await putPushKey(keyPair, machine).catch(() => undefined);
    },
    async removeMachine(deviceId) {
      const transaction = (await db()).transaction([MACHINES, PUSH_KEYS], 'readwrite');
      const finished = committed(transaction);
      transaction.objectStore(MACHINES).delete(deviceId);
      transaction.objectStore(PUSH_KEYS).delete(deviceId);
      await finished;
    },
  };
}
