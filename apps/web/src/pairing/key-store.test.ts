import { x25519KeyPairFromPrivateKey } from '@remote-control/crypto';
import type { Random } from '@remote-control/protocol';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
});
