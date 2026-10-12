# 05 — PWA / mobile frontend

Status: 2026-10-12. Role #5 (PWA / mobile frontend engineer). Input: `00-brief.md`,
`01-roles.md`, web verification (Apple/WebKit docs, Chrome docs, MDN
browser-compat-data raw JSON, WebKit Bugzilla, npm registry). Version numbers
below come from MDN BCD unless another source is named; "iOS 17" means Safari on
iOS 17 (BCD marks `safari_ios` as mirroring Safari where the number is the same).

## 1. Summary

1. Web Push on iPhone works **only in a Home Screen web app, iOS 16.4+**; it does
   not work in a Safari tab. Onboarding must gate on "installed" before asking for
   notifications. Android Chrome needs no install (WebAPK install is optional).
2. **No Allow/Deny buttons on iOS notifications** (no `actions`). The notification
   opens the app on the approval screen; the decision is made in the app. Android
   supports action buttons, but a signed, user-verified decision needs the app
   anyway, so MVP uses one flow on both platforms: tap → app → Allow/Deny.
3. The service worker **can decrypt the E2E payload** (CryptoKey in IndexedDB,
   `crypto.subtle` in SW) and show the real request text. It must always call
   `showNotification` (WebKit removes the subscription after 3 silent pushes).
4. **WebAuthn/passkeys inside an installed PWA**: supported by the platform APIs
   (iOS 16+, Android 9+, conditional UI Safari 16 / Chrome 108), but Apple does
   not document the Home Screen case; a device test is work item 1. `rp.id` must
   be a **custom domain from day one**; Railway's shared domain is not acceptable
   as an identity anchor (see §3).
5. WebCrypto baseline for E2E: **ECDH P-256 + HKDF + AES-GCM** works everywhere.
   X25519/Ed25519 need iOS 17+ / Chrome 133+/137+ — fine if minimum iOS is 17.
6. Realtime: WebSocket in foreground, heartbeat, reconnect + snapshot on
   `visibilitychange`/`pageshow`/`online`; "machine offline" comes from the
   relay's view of the agent, never from the phone's own socket state.
7. Stack: React 19 + Vite 8 + vite-plugin-pwa 2 (`injectManifest`, SW in TS),
   react-router 8, zustand 5, plain CSS (custom properties, safe-area, dark mode).
   QR via `barcode-detector` ponyfill (iOS has no native `BarcodeDetector`);
   short code is the primary pairing input.
8. Same PWA serves desktop (Chrome/Safari on macOS get push and passkeys too).

## 2. Verified facts

### 2.1 Web Push on iOS

- F1. Web Push for web apps is available on iOS/iPadOS **16.4+**, only when the
  site is added to the Home Screen; the manifest must set `display` to
  `standalone` or `fullscreen` (or the `apple-mobile-web-app-capable` meta); the
  permission must be requested from a user gesture (tap) —
  https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers
  and https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- F2. Delivery is via APNs; push endpoints are under `*.push.apple.com`; standard
  VAPID/`PushManager` API; notifications respect Focus modes; the Badging API
  (`navigator.setAppBadge`) is available to Home Screen web apps from 16.4 —
  same two sources; BCD `Navigator.setAppBadge` safari_ios 16.4
  (https://github.com/mdn/browser-compat-data/blob/main/api/Navigator.json).
- F3. **Silent-push quota**: WebKit enforces "a push subscription can process up to
  three silent pushes. After three silent pushes, we remove the push
  subscription" — WebKit commit "Enforce silent push quota"
  https://webkit.googlesource.com/WebKit/+/108ccb442e40e9705d212e74c1f213e3b5a0ea05.
  Apple's doc phrases it as `userVisibleOnly` being mandatory and pushes that
  show no notification leading to revocation (source in F1). A Discourse thread
  documents losing permission when the SW skipped the notification because the
  app was in the foreground —
  https://meta.discourse.org/t/ios-notifications-can-lose-permission-to-push-if-the-user-is-currently-active/290225
- F4. `Notification` options **not supported in Safari/iOS** (BCD
  `api/Notification.json`): `actions` (no; Chrome 53, Firefox 152), `badge`,
  `image`, `vibrate`, `renotify`, `requireInteraction` (no); `icon` and `tag`
  "can be set, but has no effect"; `silent` Safari 16.6 but **iOS no**; `data`
  iOS 16.4 —
  https://github.com/mdn/browser-compat-data/blob/main/api/Notification.json
- F5. Field confirmation of F4: on iOS the notification shows only a "View"
  button, custom actions are ignored —
  https://developer.apple.com/forums/thread/726793
- F6. `notificationclick` + `clients.openWindow(url)`: BCD lists the SW
  `notificationclick` event as **unsupported on iOS**
  (`api/ServiceWorkerGlobalScope.json`), but field reports show it fires and
  `clients.openWindow` opens the installed app at the URL when served over
  HTTPS (did not work on localhost) — thread 726793 above; a WebKit bug where the
  opened window client was inert was fixed in iOS 16.5 —
  https://meta.discourse.org/t/web-push-notifications-on-ios-dont-route-user-to-any-url-on-click/255975
- F7. **Declarative Web Push** shipped in Safari/iOS **18.4**: push JSON with
  `"web_push": 8030` and a `notification` object (`title`, required `navigate`
  URL, `body`, `lang`, `dir`, `silent`, `app_badge`); the system shows the
  notification without waking a service worker; `window.pushManager` lets a page
  subscribe without a SW — https://webkit.org/blog/16535/meet-declarative-web-push/
  and https://webkit.org/blog/16574/webkit-features-in-safari-18-4/; BCD
  `Notification.navigate` Safari 18.4 / Firefox 158 / **Chrome no**;
  `Window.pushManager` Safari 18.4, Chrome no.
- F8. The Notifications spec defines `navigate` for notifications and actions and
  says declarative push resources are fetched without a service worker —
  https://notifications.spec.whatwg.org/
- F9. Push message payload: the push service MUST accept at least **4096 bytes**
  (RFC 8030 §7.2); `Urgency` (§5.3) and `Topic` (§5.4, replace an undelivered
  message) headers exist — https://www.rfc-editor.org/rfc/rfc8030.txt
- F10. iOS 26: any site added to the Home Screen opens as a web app by default
  ("Open as Web App" toggle); a manifest is no longer required for that —
  https://webkit.org/blog/16993/news-from-wwdc25-web-technology-viewed-through-the-lens-of-safari-26/.
  No source says push became available outside Home Screen apps.
- F11. Apple reversed the iOS 17.4 plan to drop Home Screen web apps in the EU;
  the capability stays (press reports quoting Apple's developer note) —
  https://www.engadget.com/apple-backtracks-on-plans-to-get-rid-of-web-apps-on-iphones-in-the-eu-195232177.html

### 2.2 Push and install on Android Chrome

- F12. `PushManager`, SW `push` and `notificationclick` events: Chrome 40–42,
  Android mirrors; works in a normal tab, no install needed —
  https://github.com/mdn/browser-compat-data/blob/main/api/PushManager.json
- F13. `Notification.actions`, `vibrate`, `badge`, `image`: Chrome 53+ (BCD, F4).
- F14. `navigator.setAppBadge`: **chrome_android: no** (BCD); on Android the
  launcher shows a dot derived from notifications —
  https://developer.chrome.com/docs/capabilities/web-apis/badging-api
- F15. Installed PWAs on Android are WebAPKs: they run inside Chrome and share its
  profile (storage, permissions, SW) — https://web.dev/articles/webapks
- F16. `pushsubscriptionchange` event: Chrome 138, Safari 16, **iOS no** (BCD
  `api/ServiceWorkerGlobalScope.json`).

### 2.3 Service worker, crypto and storage

- F17. `CryptoKey` is structured-cloneable, so non-extractable keys can be stored
  in IndexedDB and read back by the SW —
  https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm;
  `CryptoKey` Safari 10 / iOS 9 / Chrome 37; `IDBObjectStore` Safari 8 / Chrome 24
  (BCD `api/CryptoKey.json`, `api/IDBObjectStore.json`).
- F18. `SubtleCrypto` (available in workers): ECDH, HKDF, AES-GCM, ECDSA — Safari
  ≤11 / Chrome ≤41; **X25519** Safari 17 / Chrome 133 / Firefox 130; **Ed25519**
  Safari 17 / Chrome 137 / Firefox 129; Safari generates *randomized* Ed25519
  signatures (verification unaffected); Safari does not import compressed EC
  points — https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey,
  https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/sign,
  https://github.com/mdn/browser-compat-data/blob/main/api/SubtleCrypto.json
- F19. Safari's 7-day script-writable-storage deletion: Home Screen web apps keep
  their own "days of use" counter, separate from Safari —
  https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/.
  WebKit engineers state first-party data of a Home Screen web app is not expected
  to be deleted (https://bugs.webkit.org/show_bug.cgi?id=237350), while a
  developer report of IndexedDB/SW being wiped after a week was closed WONTFIX
  (https://bugs.webkit.org/show_bug.cgi?id=232302). Behaviour is therefore not
  guaranteed; see R3.
- F20. Screen Wake Lock: iOS 18.4+ in Home Screen web apps; 16.4–18.4 did not work
  in standalone mode (BCD `Navigator.wakeLock`, https://webkit.org/b/254545#c32).

### 2.4 WebAuthn / passkeys

- F21. `PublicKeyCredential` / `navigator.credentials.{create,get}` with
  `publicKey`: Safari 13 / Chrome 67 / Chrome Android 70; conditional mediation
  (`isConditionalMediationAvailable`) Safari 16 / Chrome 108 / Firefox 119;
  `getClientCapabilities` Safari 17.4 / Chrome 133; JSON helpers
  (`parseCreationOptionsFromJSON`, `toJSON`) Safari 18.4 / Chrome 129 / Firefox
  119; Signal API (`signalUnknownCredential`) Safari 26 / Chrome 132 —
  https://github.com/mdn/browser-compat-data/blob/main/api/PublicKeyCredential.json
- F22. Synced passkeys: iOS 16+ (iCloud Keychain), Android 9+ (Google Password
  Manager), macOS 13+; cross-device (hybrid/QR) sign-in between ecosystems —
  https://passkeys.dev/device-support/
- F23. Related Origin Requests (`/.well-known/webauthn` with an `origins` list,
  limit of 5 distinct eTLD+1 labels): Chrome 128+, Safari/iOS 18+ —
  https://passkeys.dev/docs/advanced/related-origins/ and
  https://developer.chrome.com/blog/passkeys-updates-chrome-129
- F24. A vendor demo claims passkey create/get works when launched from the Home
  Screen on iPhone and Android, with no version numbers and no server side —
  https://progressier.com/pwa-capabilities/biometric-authentication-with-passkeys
- F25. Open WebKit bug: `navigator.credentials.get` intermittently never resolves
  (Safari 17.4 / iOS 17.5 beta, status NEW) —
  https://bugs.webkit.org/show_bug.cgi?id=273712; a forum report of passkey
  prompt problems when the login page is launched from a Home Screen shortcut —
  https://developer.apple.com/forums/thread/815784

### 2.5 Installability, CSS, camera

- F26. `env(safe-area-inset-*)`: Safari 11 / Chrome 69 / Firefox 65 (BCD
  `css/types/env.json`); `prefers-color-scheme`: Safari 12.1 / iOS 13 / Chrome 76;
  `display-mode` media query: Safari 13 / iOS 12.2 / Chrome 42 — but on iOS an
  installed app with `display: standalone` reports `display-mode: fullscreen`
  true and `standalone` false (BCD note, WebKit bug 264218) —
  https://github.com/mdn/browser-compat-data/blob/main/css/at-rules/media.json
- F27. `getUserMedia` in iOS Home Screen web apps works since **iOS 13.4** (fixed
  WebKit bug) — https://bugs.webkit.org/show_bug.cgi?id=185448; a scanner vendor
  still documents sporadic camera failures in standalone mode on iOS 17 —
  https://kb.strich.io/article/29-camera-access-issues-in-ios-pwa
- F28. `BarcodeDetector`: Chrome Android 83; desktop Chrome only macOS/ChromeOS;
  Safari 17 behind a flag only; Firefox no —
  https://developer.mozilla.org/en-US/docs/Web/API/BarcodeDetector
- F29. `navigator.share`: Safari 12.1 / Chrome Android 61; `navigator.vibrate`:
  Chrome 32, Safari no (BCD `api/Navigator.json`).

### 2.6 Tooling (npm `latest`, 2026-10-12, https://registry.npmjs.org/<pkg>/latest)

- F30. `vite-plugin-pwa` 2.0.0 (peer `vite ^3–^8`, workbox 7.4.1); `vite` 8.3.4;
  `react` 19.3.0; `react-router` 8.4.0 (react ≥ 19.2.7); `zustand` 5.0.15;
  `wouter` 3.13.0; `barcode-detector` 3.2.2 (zxing-wasm 3.1.5); `jsqr` 1.4.0;
  `@simplewebauthn/browser` 14.0.0 / `@simplewebauthn/server` 14.0.3; `diff`
  9.0.0; `web-push` 3.6.7.
- F31. vite-plugin-pwa `strategies: 'injectManifest'`: own SW file (`srcDir`,
  `filename`, e.g. `src/sw.ts`), `self.__WB_MANIFEST` injection point (can be
  disabled), TypeScript via `lib: ["WebWorker"]` and
  `declare let self: ServiceWorkerGlobalScope` —
  https://vite-pwa-org.netlify.app/guide/inject-manifest

## 3. Assumptions

- A1. WebAuthn create/get works inside an installed PWA on iOS 17+ (standalone)
  and inside an Android WebAPK. Evidence: platform APIs (F21), vendor demo (F24).
  Apple publishes no statement; F25 shows flakiness in Safari generally. Must be
  verified on devices (W1) before anything else is built on it.
- A2. The deep link on notification tap (`clients.openWindow('/requests/<id>')`)
  works on iOS ≥ 16.5 in production (HTTPS) per F6, despite BCD saying "no". The
  design does not depend on it (see Rec-2: resume routing).
- A3. Declarative push `mutable: true` + a SW `pushnotification` event (to rewrite
  the notification after decrypting) are described in the WebKit explainer
  (https://github.com/WebKit/explainers/blob/main/DeclarativeWebPush/README.md);
  I could not confirm the shipped member names from the blog. Not relied upon.
- A4. Railway's shared `*.up.railway.app` host is unsuitable as a WebAuthn
  `rp.id` for a product (shared parent domain; whether it is on the Public Suffix
  List was not verified). Treated as "custom domain required".
- A5. Removing a Home Screen web app on iOS deletes its storage (IndexedDB keys);
  reinstalling yields a fresh origin store → re-pair. Consistent with F19
  (separate storage) but not documented by Apple.
- A6. A WebAuthn assertion with `userVerification: "required"` costs roughly 1–3 s
  of system sheet + Face ID/fingerprint on current devices; acceptable per Allow.
  Not measured.
- A7. iOS suspends a background Home Screen web app within seconds to minutes and
  closes its WebSocket; `close`/`error` events may not fire until the app is
  foregrounded again. Widely reported, not documented; handled by Rec-5.
- A8. Camera permission in an iOS Home Screen web app may be re-prompted on each
  launch. Not verified; QR is optional (Rec-8).
- A9. Web Push encryption overhead (RFC 8291 `aes128gcm`) is ~120 bytes, so about
  3.5 KB of application payload fit in the 4096-byte minimum (F9). Not measured
  against APNs' actual limit.

## 4. Findings (brief hypotheses in this domain)

- H "PWA, one app for iPhone and Android, installable, Web Push" — **confirmed
  with a hard condition**: on iPhone the app must be installed to the Home Screen
  (F1); Safari-tab use has no push. Onboarding must make installation step 1.
- H "approve from the lock screen" (open question 4) — **changed**: the lock
  screen shows the notification; the decision is taken *in the app* after a tap
  (no action buttons on iOS, F4/F5). Android could offer Allow/Deny buttons (F13),
  but the brief's own requirement — a fresh user-verifying assertion per Allow —
  cannot be met from a notification action without opening the app. One flow.
- H "Web Push with push notification" — **confirmed**; payload budget ≈ 3.5 KB
  (F9, A9), so the push carries a compact encrypted summary, not the full request.
- H "WebAuthn / passkeys for login and fresh assertion per Allow" — **confirmed
  as feasible, verification pending** (A1). Conditional UI (F21) gives a one-tap
  login. Per-Allow assertion is a UX cost (A6), not a technical problem.
- H "E2E phone ↔ agent, keys per device" — **confirmed** for the browser side:
  non-extractable keys in IndexedDB (F17), P-256/HKDF/AES-GCM universally (F18);
  X25519/Ed25519 only if the floor is iOS 17 / recent Chrome. Decision for the
  security role; the PWA supports both.
- H "the relay sees only metadata" vs notification content — **interface**: the
  notification text is produced by the SW *after* decryption; the push payload
  itself is ciphertext plus an opaque request id. Declarative push (F7) would
  need plaintext in the payload, so it is **not** used in the MVP.
- H "QR code / short code pairing" — **changed order**: short code is the primary
  path (no camera, no permission, works everywhere); QR scanning is an add-on via
  a WASM ponyfill because iOS has no `BarcodeDetector` (F28).
- H "React + Vite" — **confirmed**; concrete versions in F30.

## 5. Recommendations

- **Rec-1. Push pipeline: imperative SW `push` handler on both platforms; decrypt
  in the SW; always show a notification.** The SW loads the device's decryption
  key from IndexedDB, decrypts the summary, shows `title: "<project>: <tool>"`,
  `body: <one-line summary>`, `data: {requestId, route}`. Any failure (no key,
  decrypt error, old payload format) still shows a generic "Approval needed —
  open remote-control" notification, inside a try/catch, before the event's
  `waitUntil` promise resolves. Alternatives: (a) declarative push (F7) — iOS
  18.4+ only, Chrome unsupported, plaintext payload breaks "relay sees metadata
  only" unless `mutable` (A3) is used; revisit later as an iOS reliability
  improvement. (b) generic notifications only — simpler but the user cannot
  triage from the lock screen; real text is the product's value.
- **Rec-2. Tap routing with a safety net.** `notificationclick` → focus an
  existing client and `postMessage({navigate})`, else `clients.openWindow(route)`.
  Independently, on app launch/`visibilitychange` the app fetches pending
  approvals and, if the current route is not an approval, navigates to the
  newest pending one. This makes A2 non-critical. Alternative: rely on the deep
  link only — rejected (BCD "no", field reports of flakiness).
- **Rec-3. Onboarding gate.** Steps: (1) create account with a passkey, (2)
  install (iOS: detect not-standalone via `navigator.standalone === false` or
  `display-mode` (F26) and show "Share → Add to Home Screen" instructions; Android:
  `beforeinstallprompt` button, optional), (3) in the installed app, a tap-driven
  "Enable notifications" step, (4) pair a machine. Push subscription is sent to
  the relay with `expirationTime` and the device id. Alternative: skip install on
  Android entirely — allowed (F12); keep the step optional there.
- **Rec-4. Passkeys.** `@simplewebauthn/browser` (F30) with conditional UI on the
  login screen, `residentKey: "required"`, `userVerification: "required"`. `rp.id`
  = the product's custom apex or subdomain from day one (A4); no Related Origins
  in MVP (F23 available if a second domain appears). Per-Allow/new-session
  assertion: call `navigator.credentials.get` directly from the tap handler with
  a relay-issued challenge bound to the request id (interface for role 02).
  Alternatives: password + TOTP — rejected (brief decided passkeys; worse UX);
  session cookie only for Allow — rejected by the brief's security requirement.
- **Rec-5. Realtime client.** One WebSocket while the app is visible; heartbeat
  every 25 s; a missing pong > 10 s closes and reconnects with backoff (1→30 s).
  On `visibilitychange→visible`, `pageshow`, `online`, and on notification
  messages from the SW: reconnect if not open and fetch a snapshot
  (`GET /api/state?since=<cursor>`), then resume the stream from the cursor.
  Polling fallback (every 15 s, visible only) after two consecutive socket
  failures. Presence: render the relay's `agentLastSeenAt`; show "machine offline
  — last seen 4 min ago" when older than 2 × agent heartbeat; show a separate,
  smaller "reconnecting…" strip for the phone's own socket. Alternatives: SSE —
  rejected (iOS leaves `readyState` OPEN after suspension; one-way; WS needed for
  sending anyway); long polling only — rejected (latency on a blocking permission).
- **Rec-6. UI stack.** React 19, Vite 8, TypeScript, vite-plugin-pwa 2 with
  `injectManifest` and `src/sw.ts` (F31); react-router 8 (declarative `<Routes>`
  only); zustand 5 stores: `auth`, `connection`, `sessions`, `pending`; plain CSS
  with custom properties, `color-scheme: light dark`, `prefers-color-scheme`,
  `viewport-fit=cover` + `env(safe-area-inset-*)`, `100dvh`,
  `overscroll-behavior: none`. No component library. Alternatives: wouter —
  smaller, lost on familiarity for the implementing agents (acceptable swap);
  Tailwind — rejected (tooling for ~10 screens); Ionic/Konsta — rejected (weight,
  lock-in); TanStack Query — rejected (state is WS-driven, not request-driven).
- **Rec-7. Screens (MVP).** `/login`, `/onboarding/*`, `/machines` (list +
  pairing), `/sessions` (grouped by project, status, last turn), `/sessions/:id`
  (steps timeline, diffs, compose box), `/requests/:id` (approval card:
  tool, args summary, cwd, Allow/Deny; or AskUserQuestion form with up to 4
  questions, single/multi-select, optional free text), `/new` (repo picker from
  the agent's allow-list → prompt → start). Diff viewer: unified diff parsed with
  `diff` (`parsePatch`), per-hunk collapse, horizontal scroll inside `<pre>`, no
  syntax highlighting. Alternative: side-by-side — rejected on 375 px width.
- **Rec-8. Pairing input.** Short code (typed) is primary; QR scanning via
  `barcode-detector` ponyfill + `getUserMedia` as an S-sized add-on (F27/F28,
  A8). Alternative: native `BarcodeDetector` only — Android-only, rejected.
- **Rec-9. Badge and presence.** `navigator.setAppBadge(pendingCount)` on iOS and
  desktop, cleared when the pending list empties (F2, F14); Android relies on the
  notification dot. No Wake Lock in MVP (F20).
- **Rec-10. Desktop.** Same origin, same bundle; a two-pane layout ≥ 900 px
  (sessions | detail); desktop Chrome/Safari get push and passkeys through the
  same code. No separate desktop client.

Interfaces needed from other roles: **02** — key agreement/signature algorithms
(P-256 vs X25519/Ed25519), which key the SW may hold (decrypt-only, never the
decision-signing key), challenge binding for the per-Allow assertion, re-pair
after key loss, pairing token entropy; **03** — push payload envelope (≤ 3.5 KB,
`{v, requestId, cipher}`), `Topic`/`Urgency` use, snapshot + cursor endpoints,
agent presence timestamps, VAPID keys; **04** — permission request and
`AskUserQuestion` schemas, diff availability per step; **06** — custom domain +
TLS on Railway, PWA static serving (manifest MIME, SW at origin root).

## 6. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | User runs the app in a Safari tab → no push; "it doesn't notify me" | High | High | Onboarding gate (Rec-3); in-app banner whenever `!standalone` on iOS |
| R2 | Subscription silently removed after 3 silent pushes (F3) | Medium | High | Always `showNotification` in try/catch (Rec-1); relay detects 410/404 from APNs and flags the device "needs re-enable" |
| R3 | iOS evicts IndexedDB/SW of an unused app (F19 ambiguity) → key loss | Low–Medium | Medium | Detect missing key at launch and on push; one-tap re-pair flow; relay marks device "unpaired" |
| R4 | Notification tap lands on the start page, not the request (A2) | Medium | Low | Resume routing to newest pending approval (Rec-2) |
| R5 | WebAuthn in installed PWA fails/hangs on some iOS versions (F25, A1) | Medium | High | Device matrix test first (W1); fallback: open the login in Safari once, passkey syncs via iCloud; retry UI with timeout |
| R6 | `rp.id` bound to a domain that later changes → all passkeys invalid | Low | High | Custom domain before first real user (A4); Related Origins only as a migration aid (F23) |
| R7 | Push payload exceeds 4096 B → rejected by push service | Medium | Medium | Agent sends a compact summary ciphertext; relay enforces size; full request via WS |
| R8 | iOS suspension leaves a dead socket; UI shows stale "online" (A7) | High | Medium | Heartbeat + resume on visibility; presence from relay timestamps (Rec-5) |
| R9 | Minimum-OS mismatch (X25519/Ed25519 on iOS 16.4) | Low | Medium | Decide the floor (Q1); capability probe at onboarding with a clear message |
| R10 | Apple policy change for Home Screen web apps (F11 precedent) | Low | High | Keep the agent/relay client-agnostic; native wrapper remains the escape hatch |
| R11 | Camera/QR unreliable in standalone (F27, A8) | Medium | Low | Short code primary (Rec-8) |

## 7. Work items

Sizes: S ≤ half a day, M ≤ 2 days, L ≤ a week. "AC" = acceptance criterion.

1. **Device feasibility spike (iOS + Android)** — M. Deps: a throwaway HTTPS
   origin on the custom domain (06). Static page + SW that: registers a passkey
   and asserts with UV; subscribes to push; receives a push whose SW handler reads
   a CryptoKey from IndexedDB and decrypts; tap opens `/requests/1`. AC: a
   pass/fail table (reviewer approved, kept with the QA material of role 07) for
   iOS 17.x, iOS 18.4+, Android 14 Chrome, covering: passkey create, passkey
   get, push received (app closed), decrypt in SW, deep link, badge. (This is
   the only item that may precede W2.)
2. **Scaffold `apps/web`** — S. Deps: none. Vite 8 + React 19 + TS + vite-plugin-pwa
   2 `injectManifest`, `src/sw.ts`, manifest (`id`, `start_url`, `scope`,
   `display: standalone`, icons 192/512 + maskable, `theme_color`), eslint +
   prettier + vitest. AC: `pnpm --filter web build` emits `sw.js` and
   `manifest.webmanifest`; Lighthouse "installable" passes in CI (or reviewer).
3. **Capability probe + onboarding gate** — M. Deps: W2. Detect standalone,
   `PushManager`, `PublicKeyCredential`, conditional UI, `crypto.subtle`
   algorithms (probe by `generateKey`); iOS install instructions; Android
   `beforeinstallprompt`. AC: vitest with mocked globals covers 6 combinations;
   manual: Safari tab on iOS shows instructions, installed app shows "Enable
   notifications".
4. **Push subscription + SW handler** — M. Deps: W2, relay push endpoints (03),
   key store (W7). Subscribe with VAPID key, send to relay; `push` handler per
   Rec-1; `notificationclick` per Rec-2; SW→page `postMessage` channel. AC: vitest
   test of the handler module with a fake `self`, asserting `showNotification` is
   called on success, on decrypt failure, and on malformed payload; Playwright
   (Chromium) test delivering a push via CDP shows the notification title.
5. **Passkey registration and login** — M. Deps: W2, relay WebAuthn endpoints
   (03/02), custom domain (06). `@simplewebauthn/browser`, conditional UI, error
   states. AC: Playwright with a virtual authenticator registers and logs in;
   manual pass on the W1 devices.
6. **Per-Allow / per-new-session assertion** — S. Deps: W5, challenge format
   (02). AC: integration test: Allow sent without an assertion is rejected; with
   an assertion bound to a different request id is rejected.
7. **Device key store + pairing (short code)** — M. Deps: 02 pairing protocol.
   IndexedDB wrapper storing non-extractable `CryptoKey`s per machine; pairing
   screen; "key missing → re-pair" detection. AC: vitest with `fake-indexeddb`;
   clearing the store makes the app show the re-pair screen on next launch.
8. **Realtime client** — M. Deps: 03 protocol + snapshot endpoint. Per Rec-5.
   AC: vitest with a fake WebSocket: heartbeat timeout triggers reconnect;
   `visibilitychange` triggers snapshot fetch; polling starts after two failures;
   presence label derives only from server timestamps.
9. **Approval card + AskUserQuestion form** — M. Deps: 04 schemas. AC: fixture
   page renders a permission request and a 4-question form (single and
   multi-select, free text); Allow/Deny buttons disabled until the assertion
   resolves; axe-core has no serious violations.
10. **Sessions list and detail** — M. Deps: W8, 04 event shapes. Grouped by
    project, status chips, last turn, steps timeline. AC: fixture with 50 sessions
    and 500 steps renders without jank at 375 px; no horizontal page scroll.
11. **Diff viewer** — M. Deps: W10. Unified diff via `diff`'s `parsePatch`, hunk
    collapse, add/remove colouring, monospace with horizontal scroll. AC: 2,000-line
    fixture diff renders < 200 ms in vitest (jsdom timing) and has no page overflow.
12. **Compose box + new-session picker** — S. Deps: W8, agent allow-list message
    (04). AC: sending a follow-up and starting a session both require the W6
    assertion; optimistic UI rolls back on relay error (test).
13. **Theming, safe areas, standalone quirks** — S. Deps: W2. Light/dark via
    `prefers-color-scheme`, safe-area insets, `100dvh`, no overscroll, status bar
    style meta. AC: screenshots at 375×812 with notch emulation in light and
    dark show no clipped content (Playwright snapshot).
14. **App badge** — S. Deps: W8. `setAppBadge(pending)` / `clearAppBadge`. AC:
    unit test of the badge effect; manual on iOS device.
15. **QR scanning (optional)** — S. Deps: W7. `barcode-detector` ponyfill +
    `getUserMedia`, falls back to the code field. AC: decodes a fixture QR image
    in a vitest run; camera denial shows the code field.
16. **Desktop two-pane layout** — S. Deps: W10. AC: at ≥ 900 px the list and the
    detail are visible side by side; keyboard navigation between them works.

## 8. Open questions for the owner

1. **Minimum platform floor.** Default: **iOS 17+ and Chrome Android ≥ 133**.
   Reason: iOS 17 unlocks X25519/Ed25519 (F18) and is the first version with
   broadly working passkeys; 16.4 remains technically possible if the security
   role chooses P-256 only.
2. **Custom domain now?** Default: **yes**, register one before the first
   external user; `rp.id` and push subscriptions are tied to it (A4, R6).
3. **Notification content level.** Default: **real text** (project, tool, one
   line of arguments) decrypted in the SW; never file contents or secrets;
   generic text if decryption fails.
4. **Biometric per Allow — reuse window?** Default: **no reuse** (fresh assertion
   each time, as the brief says); revisit after dogfooding if A6 feels heavy.
5. **QR in MVP?** Default: **short code only** in MVP; QR as W15 later.
6. **Android notification action buttons?** Default: **no** in MVP; a "Deny"
   action without biometrics could come later if the security role allows it.

## 9. Sources

- https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers
- https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- https://webkit.org/blog/12945/meet-web-push/
- https://webkit.org/blog/13966/webkit-features-in-safari-16-4/
- https://webkit.org/blog/16535/meet-declarative-web-push/
- https://webkit.org/blog/16574/webkit-features-in-safari-18-4/
- https://webkit.org/blog/15865/webkit-features-in-safari-18-0/
- https://webkit.org/blog/16993/news-from-wwdc25-web-technology-viewed-through-the-lens-of-safari-26/
- https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/
- https://webkit.googlesource.com/WebKit/+/108ccb442e40e9705d212e74c1f213e3b5a0ea05
- https://github.com/WebKit/explainers/blob/main/DeclarativeWebPush/README.md
- https://notifications.spec.whatwg.org/
- https://www.rfc-editor.org/rfc/rfc8030.txt
- https://developer.apple.com/forums/thread/726793
- https://developer.apple.com/forums/thread/815784
- https://meta.discourse.org/t/web-push-notifications-on-ios-dont-route-user-to-any-url-on-click/255975
- https://meta.discourse.org/t/ios-notifications-can-lose-permission-to-push-if-the-user-is-currently-active/290225
- https://bugs.webkit.org/show_bug.cgi?id=232302
- https://bugs.webkit.org/show_bug.cgi?id=237350
- https://bugs.webkit.org/show_bug.cgi?id=273712
- https://bugs.webkit.org/show_bug.cgi?id=185448
- https://webkit.org/b/254545#c32
- https://kb.strich.io/article/29-camera-access-issues-in-ios-pwa
- https://www.engadget.com/apple-backtracks-on-plans-to-get-rid-of-web-apps-on-iphones-in-the-eu-195232177.html
- https://web.dev/articles/webapks
- https://developer.chrome.com/docs/capabilities/web-apis/badging-api
- https://developer.chrome.com/blog/passkeys-updates-chrome-129
- https://passkeys.dev/device-support/
- https://passkeys.dev/docs/advanced/related-origins/
- https://progressier.com/pwa-capabilities/biometric-authentication-with-passkeys
- https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm
- https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey
- https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/sign
- https://developer.mozilla.org/en-US/docs/Web/API/BarcodeDetector
- https://developer.mozilla.org/en-US/docs/Web/API/Notification/actions
- MDN browser-compat-data raw JSON (main): `api/Notification.json`,
  `api/PushManager.json`, `api/ServiceWorkerGlobalScope.json`, `api/Clients.json`,
  `api/Navigator.json`, `api/Window.json`, `api/SubtleCrypto.json`,
  `api/CryptoKey.json`, `api/IDBObjectStore.json`, `api/PublicKeyCredential.json`,
  `api/CredentialsContainer.json`, `api/BarcodeDetector.json`,
  `api/MediaDevices.json`, `css/types/env.json`, `css/at-rules/media.json` —
  https://github.com/mdn/browser-compat-data
- https://vite-pwa-org.netlify.app/guide/inject-manifest
- https://registry.npmjs.org/ (`<pkg>/latest` for the packages in F30)
