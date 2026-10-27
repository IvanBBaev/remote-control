import { webCryptoRandom } from '@remote-control/crypto';
import { createPhoneService as createCorePhoneService } from '@remote-control/phone-core/realtime/phone';
import type { PhoneServiceOptions as CoreOptions } from '@remote-control/phone-core/realtime/phone';
import { IDBFactory } from 'fake-indexeddb';

import type { RelayApi } from '../auth/relay-api.js';
import { memoryPasskeyKeys } from '../auth/passkey-keys.js';
import type { PasskeyKeys } from '../auth/passkey-keys.js';
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
  readonly passkeys: PasskeyKeys;
  readonly sockets: ReturnType<typeof fakeSockets>;
  readonly timer: ManualTimer;
}

/**
 * A phone service on fake sockets, a fresh IndexedDB and a manual clock. `native` swaps
 * the PWA's WebAuthn for the native app's ceremony and device key (M4-04).
 */
export function createTestPhone(
  relay: RelayApi = fakeRelay(),
  native?: Pick<CoreOptions, 'authorize' | 'deviceKey'>,
): TestPhone {
  const timer = createManualTimer();
  const passkeys = memoryPasskeyKeys();
  const sockets = fakeSockets();
  const keyStore = createIndexedDbKeyStore({
    indexedDB: new IDBFactory(),
    random: webCryptoRandom,
  });
  const options = {
    relay,
    keyStore,
    timer,
    random: webCryptoRandom,
    createSocket: sockets.create,
    url: 'wss://rc.example.test/ws',
    version: '0.0.0-test',
    phoneName: 'iPhone',
    passkeys,
  };
  const phone = native
    ? createCorePhoneService({
        ...options,
        ...native,
        deleteAccount: () => Promise.resolve({ ok: false, failure: 'failed' }),
      })
    : createPhoneService(options);
  return { phone, keyStore, passkeys, sockets, timer };
}
