import './styles.css';

import { webCryptoRandom } from '@remote-control/crypto';

import { browserSocketFactory } from './adapters/browser-socket.js';
import { systemTimer } from './adapters/system-clock.js';
import { storageSessionHint } from './auth/auth-store.js';
import { createRelayApi } from './auth/relay-api.js';
import { bootstrap } from './bootstrap.js';
import { readBrowserEnvironment } from './capabilities.js';
import { createIndexedDbKeyStore } from './pairing/key-store.js';
import { cameraQrScanner } from './pairing/qr-scanner.js';
import { createPhoneService, phoneNameFrom, relaySocketUrl } from './realtime/phone.js';
import { bindLifecycle } from './realtime/realtime-client.js';

/** Sent in `hello`; the relay refuses versions below its floor. */
const APP_VERSION = '0.0.0';

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from index.html');

const relay = createRelayApi((input, init) => fetch(input, init));
const phone = createPhoneService({
  relay,
  keyStore: createIndexedDbKeyStore({ indexedDB: window.indexedDB, random: webCryptoRandom }),
  timer: systemTimer,
  random: webCryptoRandom,
  createSocket: browserSocketFactory(WebSocket),
  url: relaySocketUrl(window.location),
  version: APP_VERSION,
  phoneName: phoneNameFrom(navigator.userAgent),
  isVisible: () => document.visibilityState === 'visible',
});
bindLifecycle(phone, { window, document });
// `cameraQrScanner` also copes with `mediaDevices` missing outside a secure context.
const qrScanner = cameraQrScanner(navigator.mediaDevices);

void bootstrap({
  container,
  env: readBrowserEnvironment(window),
  notifications: 'Notification' in window ? Notification : undefined,
  ...('serviceWorker' in navigator && { serviceWorker: navigator.serviceWorker }),
  badge: navigator,
  ...(qrScanner && { qrScanner }),
  relay,
  phone,
  hint: storageSessionHint(() => window.localStorage),
});
