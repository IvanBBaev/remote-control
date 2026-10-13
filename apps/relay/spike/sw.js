// M0-03 device spike service worker (05 W1). Classic script on purpose: module service
// workers are not on every device the spike has to cover. Shares the IndexedDB layout
// with spike.js.

const DB_NAME = 'rc-spike';
const STORE = 'kv';
const DEEP_LINK = '/spike/requests/1';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function kv(mode, action) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = action(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

const get = (key) => kv('readonly', (store) => store.get(key));
const put = (key, value) => kv('readwrite', (store) => store.put(value, key));
const record = (id, go, detail) =>
  put(`result:${id}`, { go, detail, at: new Date().toISOString() });

const fromB64url = (text) =>
  Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));

function describeError(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

async function onPush(data) {
  const receivedAt = Date.now();
  await put('pushReceivedAt', receivedAt);
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const visible = windows.some((client) => client.visibilityState === 'visible');
  let body = 'Push received; decryption failed.';
  try {
    const message = JSON.parse(data);
    const latency = receivedAt - message.sentAt;
    await record(
      'push-received',
      !visible,
      `${visible ? 'app was visible' : 'no visible window'}, ${latency} ms after the request`,
    );
    const key = await get('aesKey');
    const plaintext = new TextDecoder().decode(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromB64url(message.iv) },
        key,
        fromB64url(message.ciphertext),
      ),
    );
    const ok = plaintext === (await get('canary'));
    await record('sw-decrypt', ok, ok ? 'canary matches' : 'canary differs');
    if (ok) body = 'Push received and decrypted. Tap to open the request.';
  } catch (error) {
    await record('sw-decrypt', false, describeError(error));
  }
  try {
    if (self.navigator.setAppBadge === undefined) throw new Error('setAppBadge missing');
    await self.navigator.setAppBadge(1);
    await record('badge', true, 'setAppBadge(1) resolved; check the icon');
  } catch (error) {
    await record('badge', false, describeError(error));
  }
  // Always show a notification: iOS revokes the subscription after silent pushes (05 F3).
  await self.registration.showNotification('remotectl spike', {
    body,
    tag: 'spike',
    data: { url: DEEP_LINK },
  });
}

self.addEventListener('push', (event) => {
  event.waitUntil(onPush(event.data === null ? '' : event.data.text()));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? DEEP_LINK, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows[0];
      if (existing !== undefined && 'navigate' in existing) {
        await existing.focus();
        await existing.navigate(url);
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
