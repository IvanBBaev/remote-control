import {
  deriveNotificationKey,
  openPushSummary,
  sealPushSummary,
  utf8,
  x25519KeyPairFromPrivateKey,
} from '@remote-control/crypto';
import type { Random } from '@remote-control/protocol';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { done, MACHINES, openKeyDb, readPushKeys } from './key-db.js';
import { createIndexedDbKeyStore } from './key-store.js';

const seeded = (byte: number): Random => ({ bytes: (length) => new Uint8Array(length).fill(byte) });

const machine = (deviceId: string, pairedAt: number) => ({
  deviceId,
  name: `mac ${deviceId}`,
  publicKey: new Uint8Array(32).fill(pairedAt),
  pairedAt,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IndexedDB key store', () => {
  it('fails to set the device id when the identity record vanished', async () => {
    const indexedDB = new IDBFactory();
    const store = createIndexedDbKeyStore({ indexedDB, random: seeded(5) });
    await store.identity();
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('remote-control');
      open.onerror = () => reject(new Error('cannot open the key store'));
      open.onsuccess = () => {
        const transaction = open.result.transaction('identity', 'readwrite');
        transaction.objectStore('identity').clear();
        transaction.oncomplete = () => {
          open.result.close();
          resolve();
        };
      };
    });
    await expect(store.setDeviceId('phone-1')).rejects.toThrow('identity record missing');
  });

  it('creates the identity once and keeps it across reopen', async () => {
    const indexedDB = new IDBFactory();
    const first = createIndexedDbKeyStore({ indexedDB, random: seeded(7) });
    const identity = await first.identity();
    expect(identity.deviceId).toBeNull();
    expect(identity.keyPair.privateKey.extractable).toBe(false);
    expect(identity.keyPair.publicKey).toEqual(
      (await x25519KeyPairFromPrivateKey(new Uint8Array(32).fill(7))).publicKey,
    );
    expect(await first.identity()).toBe(identity);

    const reopened = createIndexedDbKeyStore({ indexedDB, random: seeded(9) });
    const again = await reopened.identity();
    expect(again.keyPair.publicKey).toEqual(identity.keyPair.publicKey);
    expect(again.keyPair.privateKey.extractable).toBe(false);
  });

  it('remembers the bound device id', async () => {
    const indexedDB = new IDBFactory();
    const store = createIndexedDbKeyStore({ indexedDB, random: seeded(1) });
    await store.setDeviceId('phone-1');
    expect((await store.identity()).deviceId).toBe('phone-1');
    const reopened = createIndexedDbKeyStore({ indexedDB, random: seeded(2) });
    expect((await reopened.identity()).deviceId).toBe('phone-1');
  });

  it('falls back to the raw seed when the browser cannot store a CryptoKey', async () => {
    // Captured unbound on purpose: the spy calls it back with the store as `this`.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (typeof value === 'object' && value !== null && 'privateKey' in value) {
        throw new DOMException('CryptoKey cannot be cloned', 'DataCloneError');
      }
      return put.call(this, value, key);
    });
    const indexedDB = new IDBFactory();
    const identity = await createIndexedDbKeyStore({ indexedDB, random: seeded(3) }).identity();
    const reopened = await createIndexedDbKeyStore({ indexedDB, random: seeded(4) }).identity();
    expect(reopened.keyPair.publicKey).toEqual(identity.keyPair.publicKey);
    expect(reopened.keyPair.privateKey.extractable).toBe(false);
  });

  it('rethrows a storage failure that is not a clone error', async () => {
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new Error('quota');
    });
    const store = createIndexedDbKeyStore({ indexedDB: new IDBFactory(), random: seeded(5) });
    await expect(store.identity()).rejects.toThrow('quota');
  });

  it('keeps paired machines in pairing order and forgets them', async () => {
    const indexedDB = new IDBFactory();
    const store = createIndexedDbKeyStore({ indexedDB, random: seeded(6) });
    expect(await store.machines()).toEqual([]);
    await store.saveMachine(machine('b', 20));
    await store.saveMachine(machine('a', 10));
    const reopened = createIndexedDbKeyStore({ indexedDB, random: seeded(6) });
    expect((await reopened.machines()).map((m) => m.deviceId)).toEqual(['a', 'b']);
    expect((await reopened.machines())[0]?.publicKey).toEqual(new Uint8Array(32).fill(10));
    await reopened.removeMachine('a');
    expect((await reopened.machines()).map((m) => m.deviceId)).toEqual(['b']);
  });

  it('starts empty after the site data is cleared', async () => {
    const store = createIndexedDbKeyStore({ indexedDB: new IDBFactory(), random: seeded(8) });
    expect(await store.machines()).toEqual([]);
  });

  describe('notification keys (M1-06)', () => {
    const ENVELOPE = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
    const agentSeed = new Uint8Array(32).fill(42);

    async function pairedAgent(deviceId: string) {
      const keyPair = await x25519KeyPairFromPrivateKey(agentSeed);
      return {
        keyPair,
        machine: { deviceId, name: 'mac', publicKey: keyPair.publicKey, pairedAt: 1 },
      };
    }

    it('stores a decrypt-only key that opens what the agent sealed, and drops it on unpair', async () => {
      const indexedDB = new IDBFactory();
      const store = createIndexedDbKeyStore({ indexedDB, random: seeded(11) });
      const agent = await pairedAgent('agent-1');
      await store.saveMachine(agent.machine);

      const [key] = await readPushKeys(indexedDB);
      expect(key?.usages).toEqual(['decrypt']);
      expect(key?.extractable).toBe(false);
      const phone = (await store.identity()).keyPair;
      const sealKey = await deriveNotificationKey(agent.keyPair.privateKey, phone.publicKey, [
        'encrypt',
      ]);
      const sealed = await sealPushSummary(sealKey, ENVELOPE, utf8('{"v":1}'), seeded(3));
      const opened = await openPushSummary(key as CryptoKey, ENVELOPE, sealed);
      expect(new TextDecoder().decode(opened)).toBe('{"v":1}');

      await store.removeMachine('agent-1');
      expect(await readPushKeys(indexedDB)).toEqual([]);
      expect(await store.machines()).toEqual([]);
    });

    it('derives the missing keys of pairings made before M1-06 on load', async () => {
      const indexedDB = new IDBFactory();
      await createIndexedDbKeyStore({ indexedDB, random: seeded(12) }).identity();
      // A pairing saved by the previous release: the machine only, no key.
      const { machine } = await pairedAgent('agent-old');
      const db = await openKeyDb(indexedDB);
      await done(db.transaction(MACHINES, 'readwrite').objectStore(MACHINES).put(machine));
      db.close();
      expect(await readPushKeys(indexedDB)).toEqual([]);

      await createIndexedDbKeyStore({ indexedDB, random: seeded(13) }).identity();
      expect(await readPushKeys(indexedDB)).toHaveLength(1);
    });

    it('keeps no key when the browser cannot store a CryptoKey', async () => {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const put = IDBObjectStore.prototype.put;
      vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
        this: IDBObjectStore,
        value: unknown,
        key?: IDBValidKey,
      ) {
        if (typeof value === 'object' && value !== null && 'key' in value) {
          throw new DOMException('CryptoKey cannot be cloned', 'DataCloneError');
        }
        return put.call(this, value, key);
      });
      const indexedDB = new IDBFactory();
      const store = createIndexedDbKeyStore({ indexedDB, random: seeded(14) });
      await store.saveMachine((await pairedAgent('agent-2')).machine);
      expect(await store.machines()).toHaveLength(1);
      expect(await readPushKeys(indexedDB)).toEqual([]);
    });

    it('still saves the pairing when its key cannot be derived', async () => {
      const indexedDB = new IDBFactory();
      const store = createIndexedDbKeyStore({ indexedDB, random: seeded(15) });
      // An all-zero public key is low-order: X25519 refuses it.
      await store.saveMachine({
        ...(await pairedAgent('agent-3')).machine,
        publicKey: new Uint8Array(32),
      });
      expect(await store.machines()).toHaveLength(1);
      expect(await readPushKeys(indexedDB)).toEqual([]);
    });

    it('still loads the identity when the backfill fails', async () => {
      const indexedDB = new IDBFactory();
      const identity = await createIndexedDbKeyStore({ indexedDB, random: seeded(16) }).identity();
      vi.spyOn(IDBObjectStore.prototype, 'getAllKeys').mockImplementation(() => {
        throw new Error('broken');
      });
      const reopened = await createIndexedDbKeyStore({ indexedDB, random: seeded(17) }).identity();
      expect(reopened.keyPair.publicKey).toEqual(identity.keyPair.publicKey);
    });
  });
});
