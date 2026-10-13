// M0-03 device feasibility spike (05 W1). Throwaway: plain browser JavaScript, no build,
// removed once docs/verification/device-spike.md records the verdict. Every check writes
// a GO / NO-GO row into IndexedDB (shared with sw.js) and "Copy report" turns the rows
// into Markdown for the verification log.

const DB_NAME = 'rc-spike';
const STORE = 'kv';
const PUSH_DELAY_SECONDS = 20;

/** Rows in report order: id → capability label. */
const CHECKS = [
  ['standalone', 'Opened as an installed app (standalone)'],
  ['x25519', 'WebCrypto X25519 generateKey + deriveBits'],
  ['ed25519', 'WebCrypto Ed25519 sign + verify'],
  ['passkey-create', 'Passkey create with UV in the installed app'],
  ['passkey-get', 'Passkey get with UV in the installed app'],
  ['push-subscribe', 'PushManager.subscribe in the installed app'],
  ['push-received', 'Push received with the app closed and the phone locked'],
  ['sw-decrypt', 'Service worker decrypts the payload with a key from IndexedDB'],
  ['badge', 'App badge set from the service worker'],
  ['deep-link', 'Notification tap opens /spike/requests/1'],
];

// --- IndexedDB key-value store (same layout as sw.js) ---

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

async function record(id, go, detail) {
  await put(`result:${id}`, { go, detail, at: new Date().toISOString() });
  await render();
}

// --- helpers ---

const $ = (id) => document.getElementById(id);
const status = (text) => ($('status').textContent = text);
const random = (bytes) => crypto.getRandomValues(new Uint8Array(bytes));
const ms = (start) => `${Math.round(performance.now() - start)} ms`;
const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
const fromB64url = (text) =>
  Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));

function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function describeError(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Runs one check; an exception becomes a NO-GO row with the error name. */
async function check(id, run) {
  try {
    status(`Running: ${CHECKS.find(([key]) => key === id)[1]}…`);
    await run();
    status('Done.');
  } catch (error) {
    await record(id, false, describeError(error));
    status(`Failed: ${describeError(error)}`);
  }
}

/** The UV bit (0x04) of WebAuthn authenticator data (flags byte at offset 32). */
function userVerified(authenticatorData) {
  return (new Uint8Array(authenticatorData)[32] & 0x04) !== 0;
}

async function api(path, init) {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-rc-client': 'pwa' },
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.json();
}

// --- checks ---

async function cryptoCheck() {
  await check('x25519', async () => {
    const start = performance.now();
    const a = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
    const b = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
    const ab = await crypto.subtle.deriveBits(
      { name: 'X25519', public: b.publicKey },
      a.privateKey,
      256,
    );
    const ba = await crypto.subtle.deriveBits(
      { name: 'X25519', public: a.publicKey },
      b.privateKey,
      256,
    );
    const same = b64url(ab) === b64url(ba);
    await record('x25519', same, same ? `shared secrets match, ${ms(start)}` : 'secrets differ');
  });
  await check('ed25519', async () => {
    const start = performance.now();
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    const data = random(32);
    const signature = await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, data);
    const ok = await crypto.subtle.verify({ name: 'Ed25519' }, pair.publicKey, signature, data);
    await record('ed25519', ok, ok ? `signature verifies, ${ms(start)}` : 'verify failed');
  });
}

async function createPasskey() {
  await check('passkey-create', async () => {
    const start = performance.now();
    const credential = await navigator.credentials.create({
      publicKey: {
        rp: { id: location.hostname, name: 'remotectl spike' },
        user: { id: random(16), name: `spike-${Date.now()}`, displayName: 'remotectl spike' },
        challenge: random(32),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -8 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        timeout: 120_000,
      },
    });
    await put('credentialId', b64url(credential.rawId));
    const uv = userVerified(credential.response.getAuthenticatorData());
    await record(
      'passkey-create',
      uv,
      `${uv ? 'UV flag set' : 'UV flag missing'}, ${credential.authenticatorAttachment ?? 'attachment unknown'}, ${ms(start)}`,
    );
  });
}

async function getPasskey() {
  await check('passkey-get', async () => {
    const id = await get('credentialId');
    if (id === undefined) throw new Error('create a passkey first');
    const start = performance.now();
    const assertion = await navigator.credentials.get({
      publicKey: {
        rpId: location.hostname,
        challenge: random(32),
        allowCredentials: [{ type: 'public-key', id: fromB64url(id) }],
        userVerification: 'required',
        timeout: 120_000,
      },
    });
    const uv = userVerified(assertion.response.authenticatorData);
    await record('passkey-get', uv, `${uv ? 'UV flag set' : 'UV flag missing'}, ${ms(start)}`);
  });
}

async function registration() {
  return navigator.serviceWorker.register('/spike/sw.js', { scope: '/spike/' });
}

async function subscribe() {
  await check('push-subscribe', async () => {
    const start = performance.now();
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error(`notification permission ${permission}`);
    await registration();
    const ready = await navigator.serviceWorker.ready;
    const { publicKey } = await api('/api/spike/key');
    const subscription =
      (await ready.pushManager.getSubscription()) ??
      (await ready.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: fromB64url(publicKey),
      }));
    await put('subscription', subscription.toJSON());
    const host = new URL(subscription.endpoint).hostname;
    await record('push-subscribe', true, `push service ${host}, ${ms(start)}`);
  });
}

async function sendPush() {
  await check('push-received', async () => {
    const subscription = await get('subscription');
    if (subscription === undefined) throw new Error('subscribe first');
    // A key only this phone holds: the relay forwards ciphertext it cannot read (I1).
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    const canary = `rc-spike-canary-${b64url(random(9))}`;
    const iv = random(12);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(canary),
    );
    await put('aesKey', key);
    await put('canary', canary);
    const sentAt = Date.now();
    await put('pushSentAt', sentAt);
    await api('/api/spike/push', {
      method: 'POST',
      body: JSON.stringify({
        subscription,
        payload: JSON.stringify({ iv: b64url(iv), ciphertext: b64url(ciphertext), sentAt }),
        delaySeconds: PUSH_DELAY_SECONDS,
      }),
    });
    status(`Push scheduled. Close the app and lock the phone now (${PUSH_DELAY_SECONDS} s).`);
  });
}

// --- report ---

async function rows() {
  const out = [];
  for (const [id, label] of CHECKS) out.push([label, await get(`result:${id}`)]);
  return out;
}

async function render() {
  const body = $('results');
  body.replaceChildren();
  for (const [label, result] of await rows()) {
    const tr = document.createElement('tr');
    const verdict = result === undefined ? '—' : result.go ? 'GO' : 'NO-GO';
    for (const [text, cls] of [
      [label, ''],
      [verdict, verdict],
      [result?.detail ?? '', ''],
    ]) {
      const td = document.createElement('td');
      td.textContent = text;
      if (cls) td.className = cls;
      tr.append(td);
    }
    body.append(tr);
  }
}

async function report() {
  const lines = [
    `### ${new Date().toISOString().slice(0, 10)} — ${navigator.userAgent}`,
    '',
    '| Capability | Verdict | Detail |',
    '|---|---|---|',
  ];
  for (const [label, result] of await rows()) {
    const verdict = result === undefined ? 'not run' : result.go ? 'GO' : 'NO-GO';
    lines.push(`| ${label} | ${verdict} | ${(result?.detail ?? '').replaceAll('|', '/')} |`);
  }
  return lines.join('\n');
}

async function copyReport() {
  const text = await report();
  try {
    await navigator.clipboard.writeText(text);
    status('Report copied.');
  } catch {
    status('Clipboard refused; the report is shown below.');
    const pre = document.createElement('pre');
    pre.textContent = text;
    document.body.append(pre);
  }
}

async function reset() {
  for (const [id] of CHECKS) await kv('readwrite', (store) => store.delete(`result:${id}`));
  await render();
}

// --- start ---

async function start() {
  $('env').textContent = `${navigator.userAgent} · ${location.origin}`;
  $('crypto').onclick = cryptoCheck;
  $('create').onclick = createPasskey;
  $('get').onclick = getPasskey;
  $('subscribe').onclick = subscribe;
  $('push').onclick = sendPush;
  $('copy').onclick = copyReport;
  $('reset').onclick = reset;
  await record('standalone', isStandalone(), isStandalone() ? 'standalone' : 'browser tab');
  if ('serviceWorker' in navigator) await registration();
  const opened = /^\/spike\/requests\/(\w+)$/.exec(location.pathname);
  if (opened !== null) {
    const receivedAt = await get('pushReceivedAt');
    const after =
      receivedAt === undefined ? 'no push recorded' : `${Date.now() - receivedAt} ms after receipt`;
    await record('deep-link', opened[1] === '1', `opened /spike/requests/${opened[1]}, ${after}`);
    await navigator.clearAppBadge?.();
  }
  await render();
}

start().catch((error) => status(`Start failed: ${describeError(error)}`));
