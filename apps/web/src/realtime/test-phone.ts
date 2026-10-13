import { webCryptoRandom } from '@remote-control/crypto';
import { IDBFactory } from 'fake-indexeddb';

import type { RelayApi } from '../auth/relay-api.js';
import { fakeRelay } from '../auth/test-credentials.js';
import { createIndexedDbKeyStore } from '../pairing/key-store.js';
import type { KeyStore } from '../pairing/key-store.js';
import { createManualTimer } from '../test-timer.js';
import type { ManualTimer } from '../test-timer.js';
import { fakeSockets } from './fake-socket.js';
import { createPhoneService } from './phone.js';
import type { PhoneService } from './phone.js';

export interface TestPhone {
  readonly phone: PhoneService;
  readonly keyStore: KeyStore;
  readonly sockets: ReturnType<typeof fakeSockets>;
  readonly timer: ManualTimer;
}

/** A phone service on fake sockets, a fresh IndexedDB and a manual clock. */
export function createTestPhone(relay: RelayApi = fakeRelay()): TestPhone {
  const timer = createManualTimer();
  const sockets = fakeSockets();
  const keyStore = createIndexedDbKeyStore({
    indexedDB: new IDBFactory(),
    random: webCryptoRandom,
  });
  const phone = createPhoneService({
    relay,
    keyStore,
    timer,
    random: webCryptoRandom,
    createSocket: sockets.create,
    url: 'wss://rc.example.test/ws',
    version: '0.0.0-test',
    phoneName: 'iPhone',
  });
  return { phone, keyStore, sockets, timer };
}
