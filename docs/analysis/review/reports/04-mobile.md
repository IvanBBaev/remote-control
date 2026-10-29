# 04 — Native iOS / mobile engineer: as-built review of `apps/mobile`

Reviewer role 04 (AREA `MOB`) · repo `main @ f0281ef` · read-only review, 2026-10-29.

## 1. Summary

- **M1 release: ready (out of scope).** M1 ships the PWA (`01-roles.md` row 05). Nothing in
  `apps/mobile` is on the M1 critical path, and its 7 unit-test files pass (78 tests).
- **Native TestFlight (M4-08): not ready.**
  - A Release/TestFlight build has **no way to sign in**. The only connect path is the
    `__DEV__`-only developer relay with a pasted session cookie (F3).
  - The app **never wakes its realtime socket on foreground**. A notification Allow can
    silently expire after 30 s (F1).
  - A Face ID enrolment change leaves **no working recovery**: re-pairing hands over the same
    invalidated key, and disconnect wipes none of the local secrets (F2).
- The crypto, Secure Enclave signing and NSE decryption are carefully built and match the
  agent's check. Most gaps are lifecycle, production configuration and test reach, not
  protocol.
- Findings: 0 critical, 3 high, 4 medium, 2 low. Work items: 11 (about 21 h of Opus).

## 2. Verified facts

Code and config:

1. **Bundle ids.** iOS `dev.ivanbaev.remotecontrol` matches Q23 (`apps/mobile/app.json:12`). Version `0.0.0` (`app.json:5`).
2. **Entitlements.** Only `com.apple.security.application-groups = group.dev.ivanbaev.remotecontrol` (`app.json:14`). Missing: `associated-domains`, `com.apple.developer.usernotifications.time-sensitive` and `NSSupportsLiveActivities`.
3. **APNs mode.** expo-notifications is hard-coded to development APNs: `["expo-notifications", { "mode": "development" }]` (`app.json:28`).
4. **Environment reported to the relay.** The app picks the APNs environment from `__DEV__`: `relay.saveApnsToken({ token, environment: apnsEnvironment(__DEV__) })` (`src/state/push.ts:38`).
5. **Device key creation.** The key is a Secure Enclave P-256 key with `[.privateKeyUsage, .biometryCurrentSet]` and `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` (`modules/device-key/ios/DeviceKeyModule.swift:77-101`). The Secure Enclave token is used only off the simulator (`:92-94`).
6. **Device key reuse.** `getOrCreate` returns the existing key whenever one exists: `try Self.existingKey() ?? Self.createKey()` (`DeviceKeyModule.swift:15-21`).
7. **Signature format.** The native code signs with `.ecdsaSignatureMessageX962SHA256` over the 32 decision-hash bytes. The agent checks ES256 over `fromHex(decisionHash(...))` (`apps/agent/src/core/device-signature-check.ts:21-37`). The formats agree.
8. **Unused delete helpers.** `DeviceKey.remove()` is declared (`src/adapters/device-signer.ts:10`) but not exposed by `nativeDeviceSigner` (`:21-29`). `clearSecureKeyStore` (`src/adapters/secure-key-store.ts:90`) and `clearSharedNotificationKeys` (`src/adapters/notifications.ts:73`) have no callers. Checked with `grep -rn "remove()\|clearSecureKeyStore\|clearSharedNotificationKeys" apps/mobile/src`: definitions only.
9. **Discarded key metadata.** `pairedDeviceKey` hard-codes `userVerified: true` and drops the native `secureEnclave` flag. It returns `undefined` on any error, so the app "pairs without one and cannot allow" (`src/core/authorize.ts:28-43`).
10. **Re-pair advice.** After a failed send the app says: "If Face ID changed, pair this phone again." (`src/state/live.ts:104`).
11. **Disconnect.** `disconnect()` only stops the phone and clears the developer connection (`src/state/store.ts:116-122`). Identity seed, pairings, notification keys, device key and the relay's APNs token all stay.
12. **Developer relay is the only sign-in.** The section is `__DEV__` only (`src/app/(tabs)/settings.tsx:253`). The adapter calls itself a bearer credential "until the app has its own account sign-in" (`src/adapters/dev-connection.ts:9`). Transport sends `cookie: __Host-rc_session=<token>` (`src/adapters/relay-transport.ts`).
13. **No account deletion.** `deleteAccountWithoutPasskey` always resolves as cancelled (`src/core/authorize.ts:84-86`).
14. **No foreground wake.**
    - `grep -rn "wake\|AppState" apps/mobile/src` finds AppState only in `src/state/pending-link.ts:1,34` (the Control Center link). There is no `wake(` call.
    - `RelayPhoneService`'s socket exposes `wake()` (`packages/phone-core/src/realtime/relay-socket.ts:212-225`).
    - The web client's header says "the native app wakes the client from its own app-state events" (`apps/web/src/realtime/realtime-client.ts:1-2`). The code does not do this.
15. **Notification intent handling.**
    - Intents are queued for `INTENT_TTL_MS = 30_000` (`src/state/push.ts:30,102`).
    - `drain` silently drops expired ones: `queued = queued.filter(({ until }) => until > now)` (`push.ts:72`).
    - It auto-`decide`s resolved ones with no screen shown (`push.ts:74-79`).
16. **Generic alert carries Allow.**
    - The relay's generic alert is "Approval needed on <dev>" / "Tap to review." with `category: APNS_PENDING_CATEGORY` and `interruption-level: time-sensitive` (`apps/relay/src/core/apns-payload.ts:10-29`).
    - The NSE replaces the content only when decryption succeeds (`targets/notification-service/NotificationService.swift:13-25`). It also re-sets the category (`:83`).
    - So the Allow button exists before and without decryption.
17. **Notification actions open the app.** Every action is `opensAppToForeground + isAuthenticationRequired`, "because only the foreground app can ask Face ID for the device key's signature" (`src/core/notifications.ts:35-40`).
18. **ADR 0017 conflicts with item 17.** It says the Live Activity App Intent "asks for Face ID, signs, and sends the decision" without opening the app (`docs/adr/0017-native-phone-app.md:71-73`). It also promises "Native builds run in a separate macOS CI job" (`:103`).
19. **Keychain sharing with the NSE.** Shared notification keys use `keychainService 'rc.push'` plus access group = App Group and `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` (`src/adapters/notifications.ts:20-24`). The NSE reads `rc.push:no-auth` / `rc.push.keys` in the same group (`NotificationService.swift:59-61`).
20. **Deployment targets.** The extension targets deploy at iOS 18.0 (`targets/*/expo-target.config.json:6`). The DeviceKey podspec says 16.4 (`modules/device-key/ios/DeviceKey.podspec:8`). The widget frameworks are SwiftUI, WidgetKit and AppIntents, with no ActivityKit (`targets/widgets/expo-target.config.json:7`).

Settings screen:

21. **Settings rows.**
    - "Face ID before Allow" is a hard-coded `"On"` (`settings.tsx:259`).
    - "Live Activity & Dynamic Island" shows `"M4-06"` (`:256`).
    - A `pair=` deep link auto-starts pairing in all builds (`:87-92`). `confirm=` is dev-only (`:96`).

Tests and CI:

22. **Mobile coverage.** `vitest.config.ts:14` excludes `apps/mobile/src/{app,ui,state,adapters}/**` from coverage. `:37` holds `apps/mobile/src/**` (that is, `src/core`) at 100 %.
23. **Test run.** `node_modules/.bin/vitest run apps/mobile --coverage.enabled=false` gives `Test Files 7 passed (7) · Tests 78 passed (78)`. With coverage on, a scoped run fails only on the other packages' global thresholds, which is expected for a filtered run.
24. **No Swift CI.**
    - `grep -n -i "xcode\|swift" .github/workflows/*.yml` returns 0 hits.
    - The only macOS jobs are the agent OS matrix (`ci.yml:69`) and WebKit e2e (`e2e.yml:79`).
    - Swift tests exist only as XCUITest sources under `docs/verification/native-app/*.swift`, run by hand in a locally added target.
25. **Swift size.** About 657 lines across 8 files (DeviceKey, NSE, widgets, Control Center, shared Snapshot/Intent). None of it has unit tests.

Roadmap and verification record:

26. **M4 status in ROADMAP §4.**
    - M4-05: `partial:80` ("simctl run awaits CoreSimulator update", `ROADMAP.md:1123`).
    - M4-06: `todo`, with AC "its Deny reaches the agent" (`:1131-1138`).
    - M4-08: Size S, scope "EAS/Xcode archive, associated domains, APNs production environment, TestFlight" (`:1146-1149`).
27. **Contradictions in `docs/verification/native-app.md`.**
    - The M4-04 section ends "Result: pass" in the simulator, with no CoreSimulator problem (`:124-166`).
    - The M4-05 section says its simulator run is "blocked by the same CoreSimulator issue as M4-04 … see M4-04" (`:170-171, 200-201`).
    - Lock Screen accessories (`:120-122`) and a real Secure Enclave or biometry change (`:165`) are recorded as unverified.

## 3. Assumptions

- A1. **Invalidated key stays findable.** After a Face ID enrolment change, a `.biometryCurrentSet` key stays in the keychain and `SecItemCopyMatching` by tag still returns it. Only use (signing) fails. This is Apple's documented behaviour, but it was not verified on a device; the simulator cannot change enrolment the same way. F2 depends on it.
- A2. **No Release-build sign-in.** No hidden production sign-in path exists outside `apps/mobile/src`. Checked by grep for `passkey|ASAuthorization|webcredentials` in `apps/mobile`, with no hits.
- A3. **Suspended socket.** iOS suspends the JS runtime soon after backgrounding, and the WebSocket dies without a close frame. Without `wake()`, detection needs the 25 s heartbeat plus the 10 s pong deadline, then backoff of up to 30 s (`relay-socket.ts`). Exact iOS timing was not measured.
- A4. **APNs environment.** The relay picks the APNs host from the `environment` the app reports (`apps/relay/src/adapters/apns-sender.ts`, `apps/relay/src/http/push-routes.ts`). A sandbox token sent to the production host gets `BadDeviceToken`.
- A5. **Push token removal.** The relay has no route to delete a phone's APNs token. Not exhaustively checked.

## 4. Findings

### F1 — high — The app never wakes realtime on foreground; notification Allows can be lost silently

- **Evidence.** Facts 14 and 15. `_layout.tsx` auto-connects once and starts push sync, but no AppState listener calls `phone.wake()`. A failed cold-start connect also stays in `live: error` with no retry (`store.ts` connect catch).
- **Why it matters.** This is the primary native journey:
  1. A push arrives with the phone locked.
  2. The user taps Allow, unlocks, the app foregrounds and Face ID runs.
  3. The decision queues until the realtime inbox resolves the session.
  4. With a dead socket, reconnect takes up to about 35 s to detect, plus backoff. The 30 s TTL expires first, and the intent is dropped with no message.

  The user believes they allowed; the agent hits handoff (R11). The PWA does bind lifecycle. The web header claims the app does too, which is doc/code drift.
- **Touches:** D23 (socket only while visible, so it must reconnect fast when visible), R11, R14. Not covered by M4-05's partial status.

### F2 — high — A Face ID change has no working recovery, and disconnect leaves secrets on the phone

- **Evidence.** Facts 5, 6, 8, 10 and 11, plus assumption A1.
- **Recovery is impossible.** `.biometryCurrentSet` invalidates signing after an enrolment change, which is intended. The app's advice is "pair this phone again". But pairing calls `getOrCreate`, which returns the same dead key (`existingKey() ?? createKey()`), so the new pairing hands the agent an unusable SPKI. `remove()` is never reachable from JS. The phone can never Allow again without deleting the app.
- **Disconnect is not a sign-out.**
  - The X25519 identity seed and pairings stay.
  - The App Group notification keys stay, so the NSE keeps decrypting summaries.
  - The relay keeps the APNs token.
  - A disconnected phone still shows decrypted request summaries on its Lock Screen.
- **Touches:** D7 (user verification via device key), ADR 0017 key lifecycle, I1 (local plaintext summaries after the user thinks they left). This is not in M4-04's scope or AC.

### F3 — high (blocks M4-08) — Release builds cannot sign in

- **Evidence.** Facts 2, 12 and 13. ADR 0017:68-69 says the user signs in with a native passkey and needs associated domains.
- **Why it matters.**
  - The only way to connect is a pasted `__Host-rc_session` cookie in a `__DEV__` section. A TestFlight build therefore opens on fixture data with no connect path.
  - The cookie expires (idle and absolute session limits) and the app has no re-auth path.
  - Account deletion is impossible in-app. App Store review guideline 5.1.1(v) requires it for apps that support account creation; that matters for external TestFlight beta review and for the store.
  - M4-08 is sized S and lists only "associated domains". The sign-in flow is not scoped anywhere:
    - v3 V3-C09 is Android-only.
    - v3 `03-platform.md` RK7 covers self-host, not the owner's domain.
- **Touches:** Q2, Q22, D9 (RP ID on the final domain), M4-08 scope.

### F4 — medium — Blind Allow: the generic alert carries an Allow button before decryption

- **Evidence.** Facts 16 and 17.
- **Why it matters.** The NSE can fail for several reasons:
  - the shared keys are not written yet (`shareKeys` runs only after a machine-list change, `push.ts:93-97`);
  - the sealed body is larger than 1024 bytes;
  - the extension hits its time or memory limit;
  - the phone was rebooted and is before first unlock (`AFTER_FIRST_UNLOCK`).

  In any of these cases the user sees "Approval needed on <dev> — Tap to review." with **Allow**. Allow then runs Face ID and auto-decides (`push.ts:74-79`) without ever showing the request. Face ID proves who is deciding, not what they saw. That weakens D7's "decision bound to what the user saw" for exactly the requests the user could not read.
- **Touches:** D7, D5. The NSE is v3 lane `sec-cards`; S03c/S03d hardened rendering but not this path.

### F5 — medium — The APNs environment is a heuristic that breaks for TestFlight and Release-on-device

- **Evidence.** Facts 3 and 4.
- **Why it matters.** The `aps-environment` entitlement and the reported environment are chosen independently:
  - The entitlement is fixed to development at prebuild.
  - The reported value follows `__DEV__`.
- **Failure cases:**
  - A Release build signed with a development profile reports `production` with a sandbox token, and the relay gets `BadDeviceToken`.
  - A TestFlight build needs `mode: production` in the plugin, or its token is never valid for production APNs. The current config cannot produce a correct TestFlight build without a manual edit.
- **Touches:** D5, M4-08 ("APNs production environment"). The fix is concrete and small, so it should land before M4-08 rather than be discovered in it.

### F6 — medium — M4-06 (Live Activity) is not ready to start as scoped

- **Evidence.** Facts 17, 18, 20 and 26.
- **Why it matters.**
  - The scope says Allow/Deny are `LiveActivityIntent`s that sign and send. But the app's own design note says only the foreground app can ask Face ID. And D23 keeps no socket in the background, so a Deny from the Island has no KK channel to the agent unless the app opens.
  - The AC "Deny reaches the agent" therefore needs either opening the app (`openAppWhenRun`) or a background send path that D23 rules out.
  - Missing prerequisites:
    - `NSSupportsLiveActivities` in Info.plist;
    - ActivityKit in the widget target;
    - push-to-start and update token registration in the app (the relay schema only names an `apns_activity` kind);
    - the relay route for activity tokens.
- **Touches:** D23, ADR 0017, M4-06 scope. This needs a decision, not a design from this review.

### F7 — medium — The Swift code (NSE, DeviceKey, widgets) has no tests in CI, and the TS↔Swift contract is mirrored by comment only

- **Evidence.** Facts 22, 24 and 25. ADR 0017:103 promises a macOS CI job.
- **Why it matters.** The NSE re-implements several pieces of the TS side:
  - the push summary decode;
  - AES-GCM with AAD `rc/v1/push`+rid;
  - the shared-key JSON format;
  - category selection.

  The widget `Snapshot.swift` mirrors `widget-snapshot.ts`. A field rename on the TS side passes `pnpm check` and silently breaks decryption, which brings back the blind alert of F4. Nothing even compiles the Swift in CI, so an Expo or `@bacons/apple-targets` bump can break the native build unnoticed.
- **Touches:** ADR 0017, R9 (an NSE fallback must never leak, and it doesn't, but correctness is untested).

### F8 — low — `docs/verification/native-app.md` contradicts itself on the simulator blocker

- **Evidence.** Fact 27.
- **Why it matters.** The M4-05 partial status cites a CoreSimulator issue "as in M4-04". The M4-04 record shows a clean pass. Either M4-04's run predates the issue, which should be stated with a date and Xcode version, or the M4-05 blocker is something else. This is the record M4-08's AC writes into.
- **Touches:** none (documentation accuracy).

### F9 — low — Small configuration and honesty gaps

These are bundled because each is minutes of work:

1. **Time-sensitive entitlement.** `interruption-level: time-sensitive` is sent without the entitlement (fact 2). iOS downgrades it to active, so Focus modes will hold approvals.
2. **Hard-coded Settings row.** "Face ID before Allow: On" ignores whether a device key exists (`pairedDeviceKey` may have returned `undefined`, fact 9).
3. **Silent key failure.** Pairing without a key is silent; the user only learns at the first Allow.
4. **Lost Secure Enclave flag.** `secureEnclave` is discarded, so a software key (simulator) is also declared `userVerified: true`. Acceptable for the simulator, but the agent cannot tell the two apart.
5. **iOS floor mismatch.** The podspec says iOS 16.4, the extensions say 18.0, and the Q6 floor is iOS 17. The effective floor is 18 for the extensions, and that is undocumented.
6. **Auto-pairing deep link.** `pair=` deep links auto-start pairing in Release. The fingerprint confirmation stays manual, so this is low risk, but any web page can trigger a pairing attempt sheet.

## 5. Recommendations

1. **Bind AppState to `phone.wake()`** (RV-MOB-01).
   - On `active`: call `wake()`; if the state is `error` or there is no phone, retry `connect(saved)`.
   - Raise the intent TTL to the request's own expiry, and tell the user when an intent expires (local notification or Alert, "Allow was not sent") (RV-MOB-02).
   - *Rejected:* keep a background socket via a background task. D23 forbids it, and iOS kills it anyway.
   - *Rejected:* send the decision over HTTP from the notification action. That breaks I4/E2E (decisions ride the KK session).
2. **Make the key lifecycle explicit** (RV-MOB-03, RV-MOB-04).
   - The Swift `sign` maps `errSecAuthFailed`/invalidated-key errors to a distinct `invalidated` result.
   - The app then deletes the key and starts re-pairing, which creates a new key.
   - "Disconnect" becomes "Sign out": wipe the identity, pairings, notification keys and device key, and delete the relay APNs token.
   - *Rejected:* `.biometryAny` instead of `.biometryCurrentSet`. It would let a newly enrolled face allow, which weakens D7.
3. **Scope native sign-in explicitly before M4-08** (RV-MOB-05).
   - Use an `ASAuthorizationPlatformPublicKeyCredentialProvider` passkey on the Q2 domain, `webcredentials:` associated domain and AASA served by the relay. Add in-app account deletion and re-auth on 401.
   - *Rejected:* ship TestFlight with the dev cookie paste. It is unusable for a tester and puts a bearer token in the clipboard.
   - *Rejected:* a pairing-derived session (agent vouches for the phone). It is attractive for self-host (v3 RK7), but it changes the relay's account model and is an owner call (Q-MOB-1).
4. **Fail safe on push** (RV-MOB-06).
   - The relay sends a review-only category (Review/Deny).
   - The NSE upgrades to `rc.pending` (with Allow) only after successful decryption.
   - *Rejected:* drop the Allow action entirely. That loses the core M4-05 value when decryption works.
5. **Derive the APNs environment from the build** (RV-MOB-07). Use `app.config.ts` with `mode` from `EAS_BUILD_PROFILE`/env and expose it via `extra`, and the app reports that value.
6. **Before M4-06 starts, decide the Island execution path** (RV-MOB-08, ADR amendment only).
7. **Add a macOS CI job** that prebuilds, compiles all targets, and runs Swift unit tests for the NSE decode against **shared JSON vectors** produced by the TS tests (RV-MOB-09). This fulfils ADR 0017:103 and does not overlap V3-C11 (release workflow) or v2 P-12.
   - *Rejected:* XCUITests in CI. They are slow, flaky on hosted runners, and need a simulator boot. Keep them manual for M4-08.

## 6. Risks

These are new; ROADMAP §7 has none for the native app beyond R1 (PWA).

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| RK-MOB-1 | App Review or external TestFlight beta review rejects the build: no in-app sign-in for the reviewer, no account deletion (5.1.1(v)) | high (if external testers) | high | RV-MOB-05; use internal testers only until then (Q-MOB-3) |
| RK-MOB-2 | The owner changes Face ID (glasses, new face) and the phone silently stops allowing until the app is reinstalled | medium | high | RV-MOB-03 |
| RK-MOB-3 | An Expo SDK or `@bacons/apple-targets` bump breaks the Swift targets unnoticed, because nothing compiles them in CI | medium | medium | RV-MOB-09 |
| RK-MOB-4 | Extends R14: a relay restart while the app is backgrounded plus no foreground wake means the first notification tap after a deploy loses the decision | medium | medium | RV-MOB-01/02 |

## 7. Work items

Lane marks follow `docs/analysis/v3/PARALLEL.md`. Unmarked paths are not lane-owned.

| ID | Title | Size | Deps | Files touched | Acceptance criteria (machine-checkable) | Finding |
|---|---|---|---|---|---|---|
| RV-MOB-01 | Wake realtime on foreground; retry a failed connect | S | M4-03 | new `apps/mobile/src/core/lifecycle.ts` (+ test); new `apps/mobile/src/state/lifecycle.ts`; `apps/mobile/src/app/_layout.tsx` | `grep -rn "\.wake()" apps/mobile/src` ≥ 1 hit; vitest `lifecycle.test.ts` › "wakes on background→active" and "reconnects when live state is error" pass; `apps/mobile/src/**` coverage stays 100 % | F1 |
| RV-MOB-02 | Intent TTL follows the request expiry; the user is told when an Allow/Deny was not sent | S | RV-MOB-01 | `apps/mobile/src/state/push.ts`; `apps/mobile/src/core/notifications.ts` (new pure `expireIntents`) + test | vitest `notifications.test.ts` › "reports expired intents instead of dropping them" passes; `grep -n "INTENT_TTL_MS = 30_000" apps/mobile/src/state/push.ts` returns 0 hits | F1 |
| RV-MOB-03 | Detect an invalidated device key, delete it, re-key on re-pair | M | M4-04 | `apps/mobile/modules/device-key/ios/DeviceKeyModule.swift`; `apps/mobile/src/adapters/device-signer.ts` (iOS branch only; the Android branch is lane `android`); `apps/mobile/src/core/authorize.ts` (+ test); `apps/mobile/src/state/live.ts` | `grep -n "invalidated" apps/mobile/src/core/authorize.ts` ≥ 1; vitest `authorize.test.ts` › "maps an invalidated key to re-pair and deletes it" passes; `grep -rn "remove()" apps/mobile/src --include=*.ts` shows a call site outside the interface | F2 |
| RV-MOB-04 | "Disconnect" becomes "Sign out": wipe identity, pairings, NSE keys, device key; delete the relay APNs token | M | RV-MOB-03 | `apps/mobile/src/state/store.ts`; `apps/mobile/src/state/push.ts`; `apps/relay/src/http/push-routes.ts` (`DELETE /api/push/apns`) + relay test | each of `clearSecureKeyStore(`, `clearSharedNotificationKeys(` returns ≥ 1 call hit in `apps/mobile/src/state`; relay test "DELETE /api/push/apns removes the device token" passes; `pnpm check` green | F2 |
| RV-MOB-05 | Native account sign-in (passkey, associated domain, AASA), re-auth on 401, in-app account deletion | L | Q2, Q22, Q-MOB-1; before M4-08 | `apps/mobile/app.json` (`associated-domains`); new `apps/mobile/modules/passkey/**` or `expo` passkey adapter; `apps/mobile/src/app/(tabs)/settings.tsx`; `apps/relay` route `/.well-known/apple-app-site-association` + test | `grep -n "webcredentials:" apps/mobile/app.json` ≥ 1; relay test "AASA lists <TEAMID>.dev.ivanbaev.remotecontrol" passes; `grep -n "deleteAccountWithoutPasskey" apps/mobile/src/core/authorize.ts` returns 0 hits | F3 |
| RV-MOB-06 | Generic push uses a review-only category; the NSE upgrades to `rc.pending` only after decryption | S | M4-05 | `apps/relay/src/core/apns-payload.ts` (+ test); `apps/mobile/targets/notification-service/NotificationService.swift` (**lane `sec-cards`**); `apps/mobile/src/core/notifications.ts` (+ test) | relay vitest "generic APNs alert has no Allow category" passes (asserts `category !== 'rc.pending'`); `notifications.test.ts` › "review category has no allow action" passes | F4 |
| RV-MOB-07 | The APNs environment follows the build profile, not `__DEV__` | S | — | `apps/mobile/app.json` → new `apps/mobile/app.config.ts`; `apps/mobile/src/state/push.ts` | `grep -rn "apnsEnvironment(__DEV__)" apps/mobile/src` returns 0 hits; `grep -n '"mode": "development"' apps/mobile/app.json` returns 0 hits; `pnpm --filter @remote-control/mobile exec expo config --type introspect` with `APS_ENV=production` shows `aps-environment: production` | F5 |
| RV-MOB-08 | ADR 0017 amendment: Live Activity button execution under D23 (open app vs background) and the M4-06 prerequisite list | S | owner Q-MOB-4 | `docs/adr/0017-native-phone-app.md` or new `docs/adr/00NN-live-activity-actions.md`; ROADMAP M4-06 scope/AC note | the ADR file contains the headings "Decision" and "Prerequisites" and names `NSSupportsLiveActivities`, `ActivityKit`, `push-to-start`; M4-06 AC in ROADMAP no longer conflicts (manual review), `grep -n "openAppWhenRun\|background" ` in the ADR ≥ 1 | F6 |
| RV-MOB-09 | macOS CI job: prebuild, compile all targets, Swift unit tests on shared TS↔Swift vectors (push summary, shared keys, widget snapshot) | L | — (fulfils ADR 0017:103) | new `.github/workflows/native-ios.yml` (not `mobile-release.yml`, lane `clients`); new `packages/crypto/test-vectors/push-summary.json`; Swift test target under `apps/mobile/targets/notification-service/**` (**lane `sec-cards`**); `apps/mobile/src/core/widget-snapshot.ts` vector export (**lane `sec-cards`**) | workflow has `runs-on: macos-` and steps `expo prebuild --platform ios` and `xcodebuild test`; vitest test "push summary matches shared vectors" passes; `grep -rn "push-summary.json" apps/mobile/targets` ≥ 1 | F7 |
| RV-MOB-10 | Correct the native verification record; add a physical-device checklist for M4-08 | S | — | `docs/verification/native-app.md` | `grep -c "CoreSimulator" docs/verification/native-app.md` hits all lie in one dated section with the Xcode/iOS versions; the checklist names "Face ID enrolment change", "Secure Enclave", "Lock Screen accessory", "Release build APNs" | F8 |
| RV-MOB-11 | Small honesty fixes: time-sensitive entitlement, iOS floor alignment, live Face ID row, surface a key-less pairing, keep `secureEnclave` | S | — | `apps/mobile/app.json`; `apps/mobile/modules/device-key/ios/DeviceKey.podspec`; `apps/mobile/src/app/(tabs)/settings.tsx`; `apps/mobile/src/core/authorize.ts` (+ test) | `grep -n "usernotifications.time-sensitive" apps/mobile/app.json` ≥ 1; `grep -n "16.4" apps/mobile/modules/device-key/ios/DeviceKey.podspec` returns 0 hits; `grep -n 'value="On"' "apps/mobile/src/app/(tabs)/settings.tsx"` returns 0 hits; `authorize.test.ts` › "user-verified only when the key is in the Secure Enclave or simulator flagged" passes | F9 |

Total is about 21 h. These items do not duplicate:

- M4-06 or M4-08 (the scope there is executing the WPs; RV-MOB-05/07/08 are prerequisites they lack);
- v2 P-12;
- V3-C11 (release workflow) or V3-C12 (version gate);
- V3-S03c/S03d (done, rendering only).

## 8. Open questions for the owner

1. **Q-MOB-1 — Native sign-in method.**
   - **Default:** a native passkey on the Q2 domain, as ADR 0017:68 already states (RV-MOB-05).
   - Alternative: a pairing-vouched session, which also helps self-host (v3 RK7).
2. **Q-MOB-2 — Blind Allow.** May an Allow be given from a notification whose content was not decrypted?
   - **Default:** no. Review/Deny only until the NSE decrypts (RV-MOB-06).
3. **Q-MOB-3 — TestFlight audience for the first build.**
   - **Default:** internal testers only (no beta review) until RV-MOB-05 ships sign-in and account deletion.
4. **Q-MOB-4 — Live Activity buttons.**
   - **Default:** both buttons open the app (`openAppWhenRun`) and send over the foreground session, keeping D23.
   - Accept that the M4-06 AC is "Deny reaches the agent after the app opens".
5. **Q-MOB-5 — Minimum iOS.** The extensions are at 18.0 while Q6 says 17.
   - **Default:** document 18.0 as the native floor. The PWA covers 17.
6. **Q-MOB-6 — Build path for M4-08.**
   - **Default:** EAS Build with profiles (`development`, `preview`, `production`). This matches V3-C11 and gives RV-MOB-07 its profile variable.

## 9. Sources

- **App code.** `apps/mobile/app.json`, `apps/mobile/.gitignore` and `apps/mobile/package.json`. Under `apps/mobile/src`:
  - `app/_layout.tsx`, `app/(tabs)/settings.tsx`;
  - `adapters/{notifications,secure-key-store,device-signer,widget-store,dev-connection,relay-transport,platform}.ts`;
  - `core/{authorize,notifications}.ts`;
  - `state/{push,live,store,pending-link}.ts`.
- **Native code.**
  - `apps/mobile/modules/device-key/ios/DeviceKeyModule.swift` and `DeviceKey.podspec`;
  - `apps/mobile/targets/notification-service/NotificationService.swift`;
  - `apps/mobile/targets/*/expo-target.config.json`.
- **Shared, relay and agent code.**
  - `packages/phone-core/src/realtime/relay-socket.ts`;
  - `apps/web/src/realtime/realtime-client.ts`;
  - `apps/relay/src/core/apns-payload.ts`, `apps/relay/src/adapters/apns-sender.ts`, `apps/relay/src/http/push-routes.ts`;
  - `apps/agent/src/core/device-signature-check.ts`.
- **Config and CI.** `vitest.config.ts`, `.github/workflows/{ci,e2e,pg-real,release}.yml`.
- **Docs.**
  - `docs/adr/0017-native-phone-app.md`;
  - `docs/verification/native-app.md`;
  - `docs/analysis/ROADMAP.md` §4 (M4-01…M4-08), §6, §7;
  - `docs/analysis/v2/ROADMAP-v2.md` (P-12);
  - `docs/analysis/v3/ROADMAP-v3.md`, `docs/analysis/v3/PARALLEL.md`, `docs/analysis/v3/reports/03-platform.md` (RK7, V3-C09);
  - `docs/analysis/review/00-state.md`, `01-roles.md`.
- **Command.** `node_modules/.bin/vitest run apps/mobile --coverage.enabled=false` reported 7 files / 78 tests passed.
