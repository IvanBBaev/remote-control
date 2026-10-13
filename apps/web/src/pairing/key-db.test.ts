import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { done, MACHINES, openKeyDb, PUSH_KEYS, readPushKeys } from './key-db.js';

async function aesKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new Uint8Array(32).fill(1), 'AES-GCM', false, ['decrypt']);
}

function openV1(factory: IDBFactory): Promise<IDBDatabase> {
  const request = factory.open('remote-control', 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('identity');
    request.result.createObjectStore(MACHINES, { keyPath: 'deviceId' });
  };
  return done(request);
}

describe('key database', () => {
  it('upgrades a version 1 database and keeps its pairings', async () => {
    const factory = new IDBFactory();
    const v1 = await openV1(factory);
    const put = v1.transaction(MACHINES, 'readwrite').objectStore(MACHINES).put({ deviceId: 'a' });
    await done(put);
    v1.close();

    const db = await openKeyDb(factory);
    expect([...db.objectStoreNames].sort()).toEqual(['identity', MACHINES, PUSH_KEYS]);
    const machines = db.transaction(MACHINES, 'readonly').objectStore(MACHINES).getAll();
    expect(await done(machines)).toEqual([{ deviceId: 'a' }]);
    db.close();
  });

  it('reads every notification key and closes its connection', async () => {
    const factory = new IDBFactory();
    expect(await readPushKeys(factory)).toEqual([]);

    const key = await aesKey();
    const db = await openKeyDb(factory);
    await done(
      db.transaction(PUSH_KEYS, 'readwrite').objectStore(PUSH_KEYS).put({ deviceId: 'a', key }),
    );
    const keys = await readPushKeys(factory);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.usages).toEqual(['decrypt']);
    expect(keys[0]?.extractable).toBe(false);
    db.close();
  });

  it('closes an open connection when a newer schema arrives', async () => {
    const factory = new IDBFactory();
    const db = await openKeyDb(factory);
    const newer = factory.open('remote-control', 3);
    await done(newer);
    expect(() => db.transaction(PUSH_KEYS, 'readonly')).toThrow();
    newer.result.close();
  });

  it('fails at once when an older connection blocks the upgrade, if asked to', async () => {
    const factory = new IDBFactory();
    const v1 = await openV1(factory);
    v1.onversionchange = null;
    await expect(readPushKeys(factory)).rejects.toThrow('blocked');
    v1.close();
    // The late connection was closed, so a later upgrade is not blocked by it.
    let blockedAgain = false;
    const later = factory.open('remote-control', 3);
    later.onblocked = () => {
      blockedAgain = true;
    };
    await done(later);
    expect(blockedAgain).toBe(false);
    later.result.close();
  });
});
