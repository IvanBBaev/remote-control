/**
 * The phone's key database (05 W7), shared by the page's key store and the service
 * worker. Version 2 (M1-06) adds the decrypt-only notification keys the worker reads.
 */
export const DB_NAME = 'remote-control';
export const DB_VERSION = 2;
export const IDENTITY = 'identity';
export const MACHINES = 'machines';
export const PUSH_KEYS = 'push-keys';

/**
 * One pairing's notification key (D5): a non-extractable AES-GCM key that can only
 * decrypt, keyed by the agent's device id. It opens push summaries and nothing else.
 */
export interface StoredPushKey {
  readonly deviceId: string;
  readonly key: CryptoKey;
}

export function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'));
    };
  });
}

export function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onerror = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    };
    transaction.onabort = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    };
  });
}

// Not `instanceof DOMException`: the DOMException class differs between realms.
export function isDataCloneError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && Reflect.get(error, 'name') === 'DataCloneError'
  );
}

/**
 * Opens (and creates or upgrades) the database. A connection closes itself when another
 * context upgrades the schema, so a newer page or worker is never blocked by this one.
 * With `failWhenBlocked`, an open that an older connection blocks fails at once instead
 * of waiting (the service worker must show a notification promptly, 05 Rec-1).
 */
export function openKeyDb(
  factory: IDBFactory,
  { failWhenBlocked = false }: { readonly failWhenBlocked?: boolean } = {},
): Promise<IDBDatabase> {
  const request = factory.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = (event) => {
    const db = request.result;
    if (event.oldVersion < 1) {
      db.createObjectStore(IDENTITY);
      db.createObjectStore(MACHINES, { keyPath: 'deviceId' });
    }
    if (event.oldVersion < 2) db.createObjectStore(PUSH_KEYS, { keyPath: 'deviceId' });
  };
  const opened = done(request).then((db) => {
    db.onversionchange = () => {
      db.close();
    };
    return db;
  });
  if (!failWhenBlocked) return opened;
  return new Promise((resolve, reject) => {
    let blocked = false;
    request.onblocked = () => {
      blocked = true;
      reject(new Error('key database is blocked by an older connection'));
    };
    // The open still completes once the old connection goes; nobody holds it then.
    opened.then((db) => {
      if (blocked) db.close();
      else resolve(db);
    }, reject);
  });
}

/** Every stored notification key, for the service worker; the connection is closed after. */
export async function readPushKeys(factory: IDBFactory): Promise<CryptoKey[]> {
  const db = await openKeyDb(factory, { failWhenBlocked: true });
  try {
    const transaction = db.transaction(PUSH_KEYS, 'readonly');
    const all = (await done(transaction.objectStore(PUSH_KEYS).getAll())) as StoredPushKey[];
    return all.map(({ key }) => key);
  } finally {
    db.close();
  }
}
