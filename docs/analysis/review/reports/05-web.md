# 05 — Web / PWA frontend review (AREA: WEB)

Reviewer role: Web / PWA frontend engineer. Scope: `apps/web` (screens, state, service
worker, push subscription, passkey flows, realtime adapters, offline/reconnect, iOS PWA
constraints) and `packages/phone-core` (shared with the native app). Read-only review at
`f0281ef` (main), 2026-10-29.

## 1. Summary

The PWA is well built: it has strict typing, a thin adapter layer over phone-core, an SW that always calls `showNotification` (D5), same-origin-only navigation, an end-to-end ack outbox (D4) and 44 px touch targets. Five gaps stand out.

- **No CSP or security headers.** The relay serves the PWA origin with none at all, even though that origin renders text supplied by the agent and holds passkeys and Noise keys (F1).
- **Push can die silently.** There is no `pushsubscriptionchange` handler, the notification permission is never re-read, and push failures are swallowed (F3, F4).
- **Passkey sheet on iOS is unverified.** The WebAuthn tap path awaits a relay round trip before it opens the passkey sheet. Nobody has checked this on an iPhone, and if it fails the user just sees "cancelled" (F2, extends R1).
- **Dark-theme contrast fails WCAG AA** on the primary (Allow) button (F6).
- **The PWA reports version `0.0.0`**, which will collide with the V3-C12 version gate (F8).

**Verdicts:**
- **M1 release:** ready-with-fixes. Fix F1, F3, F4, F6 and F8. Add the F2 case to the M0-03b device run.
- **Native TestFlight** (phone-core side only): ready-with-fixes. F5, F10 and F11 apply to both apps. F15 means phone-core's tests do not live with phone-core.

## 2. Verified facts

| # | Fact | Evidence |
|---|---|---|
| V1 | No CSP, HSTS, `frame-ancestors`/X-Frame-Options, nosniff, Referrer-Policy or Permissions-Policy is set anywhere in the relay. | `grep -rni "content-security\|x-frame\|frame-ancestors\|strict-transport\|nosniff\|referrer-policy\|permissions-policy" apps/relay/src` returns no non-test hits. |
| V2 | The static site sets only `cache-control`. | `apps/relay/src/http/static-site.ts:38-40` (IMMUTABLE for `/assets/*`, `no-cache` otherwise); `:49` (SPA fallback). |
| V3 | The built `index.html` has no inline script or style and no CSP meta tag. The only scripts are `/assets/index-*.js` and `/registerSW.js`. `style={{` appears 0 times in `src`. | `apps/web/dist/index.html`; `grep -rn "style={{" apps/web/src` returns 0. |
| V4 | No `dangerouslySetInnerHTML`, `innerHTML`, `eval` or `new Function` in the web sources. | grep over `apps/web/src`, excluding tests: no hits. |
| V5 | The docs never mention CSP or security headers. | `grep -rli "content-security\|CSP\|security headers\|HSTS" docs` returns no hits. |
| V6 | The SW calls `skipWaiting()` and `clientsClaim()` unconditionally. It registers only `push` and `notificationclick`; there is no `pushsubscriptionchange` handler. | `apps/web/src/sw.ts:217-228` |
| V7 | `handlePush` always shows a notification and falls back to a generic one (D5 holds). | `apps/web/src/sw.ts:160-171` |
| V8 | `registerPush` swallows every error and returns `'failed'`. | `apps/web/src/push/push-subscription.ts:86-88` |
| V9 | Push is registered once per connect effect, with deps `[phone, userId, permission, platform]`, and the result is discarded. | `apps/web/src/app-state.tsx:87-98` |
| V10 | Notification permission is read at boot and in `requestNotifications` only. Nothing re-reads it on `visibilitychange`. | `bootstrap.tsx:114`, `app-state.tsx:78,107-110`, `onboarding.ts:46`, `screens/onboarding.tsx:66` (the whole grep result). |
| V11 | When permission is denied, the onboarding step says "Allow them … in your phone's settings, then come back", and its button is disabled. | `apps/web/src/screens/onboarding.tsx:76-90` |
| V12 | The decision tap path runs three awaits before WebAuthn: `decisionHash` (subtle digest), `api.decisionChallenge(hash)` (network) and `decisionChallenge(decision)`. Only then does it call `startAuthentication`. | `apps/web/src/auth/assert-decision.ts:27-34`; same pattern in `apps/web/src/auth/delete-account.ts:19-40`. |
| V13 | `NotAllowedError` and `AbortError` are classified as `'cancelled'`. | `apps/web/src/auth/ceremony.ts:13-16` |
| V14 | D7 binds "WebAuthn options requested on tap, not on arrival". | `docs/analysis/ROADMAP.md:287` |
| V15 | The M0-03 spike page calls `navigator.credentials.get` directly, without the app's relay round trip first. | `docs/analysis/ROADMAP.md:579-587` |
| V16 | The relay's `ack` to the phone is the **recipient's** ack, forwarded end to end, so the phone outbox drops a decision only after the agent has received it. (This disproves the earlier suspicion that the relay acked on its own receipt.) | `apps/relay/src/core/relay-router.ts:282-297,439-440`; `packages/phone-core/src/realtime/realtime-client.ts:382-392` |
| V17 | The phone acks a `data` frame before decrypting it. | `packages/phone-core/src/realtime/realtime-client.ts:398-401` |
| V18 | The KK handshake sets `peer.kk` and the state `'handshaking'`, with no timer or retry. | `packages/phone-core/src/realtime/realtime-client.ts:322-340` |
| V19 | `flush` checks `expires_at` against `timer.now()` (the phone clock). The decision itself is issued on relay time (`timer.now() + relayOffset`). | `realtime-client.ts:596-599` vs `phone-core/src/realtime/phone.ts:286-288`; `DECISION_TTL_SECONDS = 300` at `packages/protocol/src/canonical-decision.ts:8`. |
| V20 | Phone backoff is `Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt)`, with no jitter. The agent's backoff is jittered. | `packages/phone-core/src/realtime/relay-socket.ts:124`; `ROADMAP.md:502,742` |
| V21 | The PWA sends `APP_VERSION = '0.0.0'` in `hello`. | `apps/web/src/main.tsx:22`. V3-C12 (version gate, MIN_* versions) is `todo` at `docs/analysis/v3/ROADMAP-v3.md:26`. |
| V22 | `paired` is `device.paired \|\| machines`, so it stays true after the last computer is removed. | `apps/web/src/app-state.tsx:100` |
| V23 | Contrast ratios computed from the `styles.css:5-34` tokens (WCAG formula): <br>• Dark, white on `#3b82f6` (`button.primary`): **3.68** <br>• Dark, white on `#f87171` (`mark.hidden-char`, `styles.css:694-697`): **2.77** <br>• Light, `--color-muted` on `--color-surface` (`.notice`, `styles.css:100-105`): **4.39** <br>• Every other pair is ≥ 4.83. | Python script using the WCAG luminance formula. |
| V24 | The stylesheet has a `:focus-visible` outline (`styles.css:172-174`) and 44 px minimum targets (`styles.css:123-130`). There are no animations or transitions, so reduced motion is N/A today. | `grep -n "animation\|transition\|@keyframes" styles.css` returns no hits. |
| V25 | `role="alert"` is used only in `auth.tsx:79,212`, `pairing.tsx:17` and `revealed.tsx:29`. Failure notices without it: `approval.tsx:208`, `question.tsx:234`, `session-commands.tsx:75,78`, `main.tsx:181,252`. There is no `aria-live` region and no programmatic focus on route change; the `Screen` `<h1>` (`layout.tsx:21`) is never focused. | grep over `apps/web/src` |
| V26 | Bundle sizes:<br>• Main chunk `index-DzXLqLcr.js`: 459,341 B raw, 139,919 B gzip -9.<br>• `ponyfill-*.js`: 14,734 B gzip, lazy (`qr-scanner.ts:44`).<br>• `zxing_reader-*.wasm`: 966,895 B. It is lazy, and it is not in `globPatterns` (`vite.config.ts:22`).<br>• `zod` appears 309 times in the main chunk.<br>• `@noble/*` is not bundled: the separate `crypto/noble` entry is used (ADR 0017, `packages/crypto/src/noble.ts:1-2`). | `ls -la dist/assets`; `gzip -9c \| wc -c` (dist built 2026-10-28 01:40) |
| V27 | `scripts/check-build.mjs` checks manifest, icons, SW and `index.html` only. It has no size budget. | `apps/web/scripts/check-build.mjs:24-75` |
| V28 | phone-core's own package has one test (`card-safety.test.ts`). Its realtime suites live in `apps/web/src/realtime/*.test.ts` and run against re-export shims. | `apps/web/src/realtime/realtime-client.test.ts` (1084 lines), `phone.test.ts` (821) |
| V29 | Scoped tests failed under heavy machine load.<br>• Command: `vitest run --project web --coverage.enabled=false apps/web`<br>• Run 1: 41 files, 514 passed, **7 failed**. Run 2: 6 failed, a different set.<br>• Failures: mostly `Test timed out in 5000ms` (`main.test.ts`, `realtime-client.test.ts` polling/pairing/diff) and one 30 s harness timeout.<br>• Load average was 81 on 10 cores (`uptime`). The `web` project has no `testTimeout`; the `node` project sets 20 s (`vitest.config.ts:48`).<br>• A coverage-enabled run could not take the reports-directory lock (another agent was running). | test output |

## 3. Assumptions

- A1. WebKit gives a WebAuthn call its user activation only for a short window (about 1 s) across awaited promises. A slow `decisionChallenge` fetch can make the call lose that activation. I infer this from WebKit behaviour; it is not measured here (F2).
- A2. Production serves the PWA from the relay origin via `static-site.ts`, as the `vite.config.ts` comment says. If a CDN fronts it later, F1 moves to the CDN config.
- A3. The phone-core realtime-store keeps `requests` and `diffs` in memory for the life of the page. I did not measure growth, so it is only a low note inside F12.
- A4. The V29 test failures come from CPU contention (other review agents were running), not from logic regressions. CI on an idle runner is the reference.

## 4. Findings

**F1 — high — The PWA origin has no CSP and no security headers.**
- Evidence: V1, V2, V5. `index.html` has no inline code (V3), so a strict policy costs nothing.
- Why it matters: this origin renders untrusted agent-supplied text (tool inputs, diffs, questions) and holds three things:
  - the IndexedDB Noise static key (`pairing/key-db.ts`);
  - the passkey session cookie;
  - the push keys the SW reads.
- What headers would add: React escaping (V4) is currently the only line of defence. A CSP adds a second layer against injection through a future dependency or a sanitiser bug. `frame-ancestors 'none'` stops clickjacking of the approval UI. HSTS protects the first visit before D8's `__Host-` cookie applies.
- Touches: I1 (decision must be the user's), I3, D8, R6.

**F2 — high (device-unverified) — The passkey sheet may not open on iOS after the awaited relay fetch.**
- Evidence: V12, V13, V14, V15.
- The code knows about the constraint: `phone.ts:121` says "Call it from the tap handler, so iOS lets the passkey sheet open". But `assertDecision` awaits a network round trip before `startAuthentication`.
- When the relay is slow (Railway cold start, R14 reconnect storm, bad cellular), WebKit may reject with `NotAllowedError`.
- The UI reports that as 'cancelled', so the user believes they dismissed it and taps again; the agent hold time runs down meanwhile (I2 holds, but UX fails).
- M0-03 only tests `credentials.get` from a direct tap (V15), so the device spike would not catch this.
- Touches: R1 (extends it), D7, M0-03b.

**F3 — medium — Notification permission is never re-read; the denied path is a dead end.**
- Evidence: V10, V11.
- The screen tells the user to fix the permission in Settings and come back. On return nothing re-reads `Notification.permission`, so onboarding stays blocked until the app is killed and relaunched.
- The reverse case is also missed: a revocation after onboarding is not reflected, so the app still looks push-ready while D4's 3 s push fallback never reaches the phone.
- Touches: D4, D5, R1.

**F4 — medium — The push subscription lifecycle has no recovery and no visibility.**
- Evidence: V6, V8, V9.
- The browser may rotate or expire a subscription; iOS does this after long inactivity, and VAPID key rotation does it too.
- There is no `pushsubscriptionchange` handler, so re-subscription happens only on the next sign-in or connect effect.
- `registerPush` failures are swallowed and never reach UI state. A user with a dead subscription gets no notifications and no hint.
- Touches: D4 (push is the wake path when no ack arrives), D5, R1.

**F5 — medium — No timeout or retry on the KK handshake.**
- Evidence: V18.
- If KK msg1 or msg2 is lost (relay replica restart mid-handshake, agent busy), the machine stays `'handshaking'` and the outbox for it is never flushed. This lasts until a presence change or a socket reconnect.
- With D23 (socket only while visible), the user can sit on an approval card whose decision is queued but never sent. I2 holds because the agent times out, but the approval is lost silently.
- Affects both the PWA and the native app (phone-core).
- Touches: D3, D4, R14.

**F6 — medium — Dark-theme contrast is below WCAG 2.x AA.**
- Evidence: V23.
- `button.primary` (Allow, Pair, Sign in) is 3.68:1 for 16 px semibold text; AA needs 4.5:1 for that size.
- `mark.hidden-char` is 2.77:1. It is part of V3-S03's card hardening (`styles.css:693-698`), the sec-cards lane's visual output.
- `.notice` in the light theme is 4.39:1.
- The fix is token-only (`--color-accent` and `--color-danger` in the dark block).
- Touches: accessibility; R1-adjacent (approval legibility in the sun at night).

**F7 — medium — Errors and screen changes are not announced to assistive tech.**
- Evidence: V25.
- Decision failures (`approval.tsx:208`, `question.tsx:234` — **v3 sec-cards lane**), command failures (`session-commands.tsx:75-78`), and revoke and delete failures (`main.tsx:181,252`) appear silently.
- Route changes do not move focus, and no live region announces a new request or a connection loss.
- A VoiceOver user tapping Allow gets no feedback when the passkey step fails.
- Touches: accessibility (WCAG 4.1.3, 2.4.3).

**F8 — medium — The PWA always reports version `0.0.0`.**
- Evidence: V21.
- V3-C12 adds `MIN_*` versions and `upgrade_required`. With a constant `0.0.0`, the gate must either exempt the PWA or reject every PWA.
- It cannot tell a stale cached PWA (F9) from a current one, which is exactly the skew case V3-C12 exists for.
- Touches: V3-C12 (extends it), I4.

**F9 — low — `skipWaiting` plus `clientsClaim` plus outdated-cache cleanup can strand an open page after a deploy.**
- Evidence: V6, V26.
- After a deploy the new SW activates immediately and `cleanupOutdatedCaches` deletes the old precache. The relay serves only the new `dist/`.
- An open page still running the old main chunk will then 404 on its lazy `ponyfill-*.js` and the zxing wasm, so QR pairing fails until a reload.
- The same open page also keeps speaking the old protocol until reloaded (see F8).
- Touches: V3-C12, I4.

**F10 — low — Phone reconnect backoff has no jitter.**
- Evidence: V20.
- After a relay restart (R14), every phone reconnects on the same 1, 2, 4… s schedule and runs KK with every agent at once. The agent side is already jittered.
- Touches: R14.

**F11 — low — The outbox expiry check uses the phone clock, while decisions use relay time.**
- Evidence: V19.
- With skew of more than 300 s, a fast phone clock drops a valid decision locally as `'expired'`. A slow clock sends an already-expired decision, which the agent then rejects.
- Fix: use `timer.now() + relayOffset` in `flush`.
- Touches: D7.

**F12 — low — Smaller state issues.**
- (a) `paired` is sticky (V22): after the last computer is removed, the pair onboarding step is skipped.
- (b) `data` is acked before decrypt (V17). Non-pending frames (sessions, `resolved`) are lost when a decrypt fails. Pending requests are re-sent after the re-handshake (D4), so I2 holds.
- (c) The `requests` and `diffs` maps are never pruned (A3).
- Touches: D4, D25.

**F13 — low — No bundle budget.**
- Evidence: V26, V27.
- The main chunk is 140 KB gzip. Everything is in one route chunk, including zod. The build check guards installability, not size, so growth goes unnoticed.
- This matters on cold push-tap launches over cellular (R1-adjacent latency).

**F14 — low — phone-core's tests are hosted by the PWA, and the web project uses the default 5 s timeout.**
- Evidence: V28, V29.
- The native app ships phone-core, but the package's realtime behaviour is tested only through `apps/web` shims. A future web-only change to a shim could mask a phone-core regression.
- The `web` project lacks a `testTimeout`, so WebCrypto-heavy suites time out under load (6–7 failures observed).
- Touches: M4 (native), CI reliability.

Counts by severity:
- critical: 0
- high: 2 (F1, F2)
- medium: 6 (F3–F8)
- low: 6 (F9–F14)

## 5. Recommendations

**R-1 (F1). Add security headers to every HTML and SW response in `static-site.ts`.**
- The policy:
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`.
  `'wasm-unsafe-eval'` is there for zxing.
- Also set:
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
  - `Permissions-Policy: camera=(self), publickey-credentials-get=(self)`
- Rejected: a `<meta http-equiv>` CSP. It cannot carry `frame-ancestors` and does not cover the SW script.
- Rejected: `@fastify/helmet`. It is a new dependency, and its defaults would still need a custom CSP.

**R-2 (F2). Measure first, then decide.**
- Add a case to M0-03b's device run: an Allow tap against a relay delayed by 1.5 s and 3 s (a query flag on the spike page). Record GO/NO-GO.
- In the app, tell "the sheet never opened" apart from "the user cancelled" by timing: `NotAllowedError` within 300 ms with no sheet shown becomes `'activation_lost'`, and the UI asks the user to tap again.
- If NO-GO, write an ADR amending D7. Build the options locally: the challenge is deterministic, and rpId and allowCredentials are cached at sign-in. The relay then binds the challenge on `/verify`.
- Rejected: prefetching options on arrival. It violates D7 as written.

**R-3 (F3, F4). Make permission and subscription state live.**
- Re-read `Notification.permission` on `visibilitychange` and `pageshow`.
- On every visible wake while signed in, call `registerPush()`. It is idempotent: the same key reuses the subscription.
- Add a `pushsubscriptionchange` handler in `sw.ts`. It re-subscribes with the stored VAPID key and POSTs to the relay; if it cannot, it flags the state for the next foreground.
- Surface `'failed'` as a non-blocking banner.
- Rejected: periodic background sync. It is not supported on iOS.

**R-4 (F5). Add a handshake deadline in phone-core.**
- If KK has not completed within 10 s, drop the session, apply the backoff with jitter, and retry while the peer is online.
- Rejected: reconnecting the whole socket. That penalises every other machine.

**R-5 (F6, F7). Accessibility fixes.**
- F6: darken the dark `--color-accent` to ≥ 4.5:1 with white text (for example `#2563eb`, 5.17), and use a darker `mark.hidden-char` background in dark mode.
- F7: one shared `<ErrorNotice>` with `role="alert"`, and focus the `Screen` `<h1>` (`tabIndex=-1`) on route change. Changes to approval.tsx and question.tsx are one-line swaps that need **sec-cards lane** sign-off.
- Also add an empty `@media (prefers-reduced-motion: reduce)` guard now, so future animations start compliant.

**R-6 (F8, F9). Version and update handling.**
- Inject `APP_VERSION` from `package.json` via Vite `define`. Hand the value to V3-C12 as the PWA's version.
- Replace the unconditional `skipWaiting` with a "new version — reload" prompt. Activate on its tap, or on the next cold start.
- Rejected: keeping old assets on the relay. Deploys are a single `dist/` copy.

**R-7 (F10–F14). Small fixes.**
- Add ±20 % jitter to the phone-socket backoff.
- Use relay time in `flush`.
- Base `paired` on `machines` only once machines have loaded.
- Ack `data` after a successful decrypt.
- Add a size budget in `check-build.mjs`: main chunk ≤ 160 KB gzip, fail above.
- Set `testTimeout: 20_000` for the `web` project.
- Give phone-core its own node-environment realtime suite: move `realtime-client.test.ts` and `phone.test.ts` and leave the shims untested.
- Rejected: route-level code splitting now. 140 KB is acceptable; the budget is enough to stop growth.

## 6. Risks (new)

- **RW-1** (extends R1): the device spike passes on the synthetic page, but the production app fails UV on iPhone because the slow pre-WebAuthn fetch loses user activation (F2). Likelihood: medium. Impact: fatal for approvals on iOS.
- **RW-2** (extends R14): after a relay restart, synchronised reconnects and KK runs, plus handshakes with no timeout, leave some machines stuck in `'handshaking'` (F5, F10).
- **RW-3**: push silently stops for a long-lived iOS install after subscription rotation; the user discovers it only when a request times out (F4).
- **RW-4** (extends V3-C12): the version gate cannot tell PWA builds apart (F8).

## 7. Work items

| ID | Title | Size | Deps | Files touched | Machine-checkable AC | Finding |
|---|---|---|---|---|---|---|
| RV-WEB-01 | Security headers and CSP for the PWA origin | S | — | `apps/relay/src/http/static-site.ts`, `static-site.test.ts` | A test asserts that `GET /` and `GET /sw.js` carry `content-security-policy` containing `frame-ancestors 'none'` and `script-src 'self' 'wasm-unsafe-eval'`, plus HSTS, nosniff, `referrer-policy`; e2e P1 (pair) passes with no CSP console errors | F1 |
| RV-WEB-02 | Distinguish lost activation from cancel; add the delayed-relay case to M0-03b | M | M0-03b (device run) | `apps/web/src/auth/{ceremony,assert-decision}.ts`, tests, `docs/verification/device-spike.md` | Unit test: an immediate `NotAllowedError` maps to `'activation_lost'`; device-spike.md has a GO/NO-GO row "Allow after 1.5 s / 3 s relay delay" | F2 |
| RV-WEB-03 | Live notification permission and per-wake `registerPush` | S | — | `apps/web/src/app-state.tsx`, `bootstrap.tsx`, tests | Test: after `visibilitychange` with permission flipped to `granted`, `nextOnboardingStep` advances past notifications and `registerPush` is called once | F3 |
| RV-WEB-04 | `pushsubscriptionchange` handler and a visible push-failed state | M | RV-WEB-03 | `apps/web/src/sw.ts`, `push/push-subscription.ts`, `screens/main.tsx`, tests | SW test: dispatching `pushsubscriptionchange` calls `subscribe` and the relay register endpoint; UI test: `registerPush → 'failed'` renders an element with `role="status"` | F4 |
| RV-WEB-05 | KK handshake deadline and retry | S | — | `packages/phone-core/src/realtime/realtime-client.ts`, test | Fake-timer test: KK msg2 dropped → after 10 s a new msg1 is sent and the queued decision is flushed after the reply | F5 |
| RV-WEB-06 | Dark-theme contrast tokens | S | — | `apps/web/src/styles.css` (the `.approval-card mark.hidden-char` rule is **sec-cards lane** output: coordinate) | A script test computes contrast from the CSS tokens: every text/background pair is ≥ 4.5 in both schemes | F6 |
| RV-WEB-07 | Announce errors; focus heading on route change | M | — | `apps/web/src/screens/layout.tsx`, `session-commands.tsx`, `main.tsx`, **`screens/approval.tsx`, `screens/question.tsx` (v3 sec-cards lane)**, tests | `grep -rn 'className="notice error"' apps/web/src/screens` returns 0 outside `ErrorNotice`; test: after navigation, `document.activeElement` is `#screen-title` | F7 |
| RV-WEB-08 | Real `APP_VERSION` from package.json | S | feeds V3-C12 | `apps/web/vite.config.ts`, `src/main.tsx`, test | Test: `hello.client.version` equals `apps/web/package.json` version; `grep "'0.0.0'" apps/web/src/main.tsx` returns 0 | F8 |
| RV-WEB-09 | Prompted SW update instead of unconditional `skipWaiting` | M | RV-WEB-08 | `apps/web/src/sw.ts`, `main.tsx`, `screens/layout.tsx`, tests | SW test: install does not call `skipWaiting`; a `SKIP_WAITING` message does; UI test: a waiting worker shows a "Reload" button | F9 |
| RV-WEB-10 | Backoff jitter and relay-time outbox expiry | S | — | `packages/phone-core/src/realtime/{relay-socket,realtime-client}.ts`, tests | Test: 100 backoff draws for attempt 3 are not all equal and stay within ±20 %; test: phone clock +400 s with offset −400 s does not expire a fresh decision | F10, F11 |
| RV-WEB-11 | State hygiene: `paired`, ack-after-decrypt, prune resolved views | S | — | `apps/web/src/app-state.tsx`, `packages/phone-core/src/realtime/{realtime-client,realtime-store}.ts`, tests | Tests: removing the last machine returns onboarding to `pair`; an undecryptable `data` frame is not acked; resolved requests older than 1 h are pruned | F12 |
| RV-WEB-12 | Bundle budget in `check-build.mjs` | S | — | `apps/web/scripts/check-build.mjs` | `pnpm --filter @remote-control/web build` fails when the main chunk is > 160 KB gzip (test with a lowered threshold) | F13 |
| RV-WEB-13 | phone-core owns its realtime tests; web `testTimeout` | M | — | `packages/phone-core/src/realtime/*.test.ts` (moved from `apps/web/src/realtime/`), `vitest.config.ts` | `ls packages/phone-core/src/realtime/*.test.ts` shows ≥ 3 files; the phone-core coverage threshold of 95 % lines is met from the package's own tests; `web` project `testTimeout` ≥ 20000 | F14 |

Total: 13 work items: 8 S, 5 M, 0 L.

## 8. Open questions for the owner

1. **F2:** if the delayed-relay device case is NO-GO, may D7 be amended by ADR so the phone builds WebAuthn options locally and the relay binds the challenge at `/verify`? Default: measure first (RV-WEB-02); no ADR until NO-GO.
2. **F9:** should the PWA prompt "new version — reload", or silently update on the next cold start? Default: prompt (RV-WEB-09).
3. **F1:** is HSTS `includeSubDomains` acceptable for the production domain (Q2)? Default: yes, without `preload`.
4. **F13:** is the 160 KB gzip budget for the main chunk acceptable? Default: yes.

## 9. Sources

- **Code:**
  - `apps/web/{index.html,vite.config.ts,package.json,scripts/check-build.mjs}`
  - `apps/web/src/{main.tsx,bootstrap.tsx,app-state.tsx,onboarding.ts,routes.tsx,capabilities.ts,online.ts,sw.ts,styles.css}`
  - `apps/web/src/push/{push-subscription.ts,pending-watch.tsx,navigation.ts}`
  - `apps/web/src/auth/{auth-store,assert-decision,ceremony,delete-account}.ts`
  - `apps/web/src/screens/*.tsx` (approval.tsx and question.tsx cited only; sec-cards lane)
  - `apps/web/src/realtime/*`
  - `packages/phone-core/src/realtime/{realtime-client,relay-socket,phone,realtime-store}.ts`
  - `packages/crypto/src/noble.ts`
  - `apps/relay/src/http/static-site.ts`, `apps/relay/src/core/relay-router.ts`
  - `vitest.config.ts`
- **Docs:**
  - `docs/analysis/ROADMAP.md`: §1 I1–I4; D3–D9, D21–D25; M0-03; Q1–Q23; R1–R19
  - `docs/analysis/v3/{ROADMAP-v3.md,PARALLEL.md}`: V3-S03..S03d, V3-C12, V3-C13, V3-C15; lanes
  - `docs/analysis/v2/ROADMAP-v2.md`
  - `docs/verification/device-spike.md`
- **Commands:**
  - grep and wc over the paths above
  - `gzip -9c dist/assets/*.js | wc -c`
  - contrast computed with the WCAG luminance formula
  - `vitest run --project web --coverage.enabled=false apps/web` (two runs, under load)
