import './styles.css';

import { webCryptoRandom } from '@remote-control/crypto';

import { browserMediaQuery } from './adapters/browser-media-query.js';
import { browserSocketFactory } from './adapters/browser-socket.js';
import { systemTimer } from './adapters/system-clock.js';
import { storageSessionHint } from './auth/auth-store.js';
import { storagePasskeyKeys } from './auth/passkey-keys.js';
import { createRelayApi } from './auth/relay-api.js';
import { bootstrap } from './bootstrap.js';
import { readBrowserEnvironment } from './capabilities.js';
import { storageInstallChoice } from './onboarding.js';
import { createIndexedDbKeyStore } from './pairing/key-store.js';
import { cameraQrScanner } from './pairing/qr-scanner.js';
import { createPhoneService, phoneNameFrom, relaySocketUrl } from './realtime/phone.js';
import { bindLifecycle } from './realtime/realtime-client.js';
import { browserUsageStorage } from './realtime/usage-stats.js';
import { WIDE_LAYOUT_QUERY } from './screens/split.js';

/** Sent in `hello`; the relay refuses versions below its floor. */
const APP_VERSION = '0.0.0';

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from index.html');

const relay = createRelayApi((input, init) => fetch(input, init));
const passkeys = storagePasskeyKeys(() => window.localStorage);
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
  usageStorage: browserUsageStorage(() => window.localStorage),
  passkeys,
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
  passkeys,
  installChoice: storageInstallChoice(() => window.localStorage),
  // Browsers without `matchMedia` stay on the one-pane phone layout.
  ...(typeof window.matchMedia === 'function' && {
    wideLayout: browserMediaQuery(window, WIDE_LAYOUT_QUERY),
  }),
});
