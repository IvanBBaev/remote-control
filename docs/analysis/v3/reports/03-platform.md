# v3 report 03 — Platform & clients

Author role: Platform & clients engineer. Date: 2026-10-28. Scope: 3.0 platform reach,
self-host, Android, watch/desktop/chat, residency and cells, solo operability, release
automation and version skew, metadata-safe observability.

Baseline: v1 ROADMAP (M4 native iOS app in progress: M4-01..04, M4-07 done; M4-05
partial:80; M4-06, M4-08 todo), ADR 0012, 0016, 0017, and the v2 corpus
(`v2/reports/03-platform.md`, `v2/SYNTHESIS.md`, `v2/ROADMAP-v2.md`). v2 facts are cited
as "v2-P §x", not repeated.

## 1. Summary

- **Build first:** a stateless, open-source push gateway (APNs + FCM) run by the
  publisher. Both hosted cells and any later self-host use it, so the `.p8` and FCM key
  live in one service and never reach a user deployment.
- **Android: IN** if the owner or the demand gate says go. It reuses Expo, phone-core and
  the D7 flow, adds a Kotlin StrongBox/TEE key and an FCM v1 adapter. Start the Play
  closed test (12 testers × 14 days) at the first stable build. That is the long pole.
- **Watch:** notify and Deny only. **Desktop:** the installable PWA (it already decides
  with a passkey). **Slack/Teams:** notify-only with a deep link. Watch Allow, chat
  decisions, Tauri/Electron and a native watchOS app are **OUT**.
- **Self-host:** IN only in branch A (teams exist), via an ADR that amends the §1
  "Never". In branch B it is OUT: ship the gateway and stop there.
- **Ops:** at most 2 cells, no OTA, a version gate with N/N-1 skew, one mobile-release
  workflow, aggregate counters only.

## 2. Verified facts

v1/v2 facts are cited, not repeated. These are new for v3 or re-checked on 2026-10-28.

**Push credentials**
- APNs token-auth keys are either team-scoped (Sandbox or Production only, at most 2 per
  environment, all topics of the team) or topic-specific (up to 200 keys per environment,
  up to 400 topics per key). The JWT is ES256 with `iss` = Team ID. Refresh it no more
  often than every 20 minutes and no less often than every 60 minutes. One connection
  cannot serve multiple teams.
  https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns.md
- The FCM legacy APIs were deprecated on 2023-06-20 and shutdown began on 2024-07-22.
  HTTP v1 authenticates with OAuth2 service-account tokens.
  https://firebase.google.com/docs/cloud-messaging/migrate-v1
- Expo/EAS needs the FCM V1 service-account JSON uploaded to EAS, plus
  `google-services.json`, which is not secret and can be committed.
  https://docs.expo.dev/push-notifications/fcm-credentials/
- Sygnal is the Matrix reference push gateway: one service that holds the APNs (cert or
  token) and FCM credentials on behalf of many homeservers.
  https://github.com/matrix-org/sygnal
- UnifiedPush with ntfy as distributor gives FCM-free Android push, at the cost of a
  second app on the phone. https://f-droid.org/2022/12/18/unifiedpush.html

**Android**
- Personal Play accounts created after 2023-11-13 must run a closed test with at least
  12 opted-in testers for 14 consecutive days before applying for production. Review is
  usually 7 days or less.
  https://support.google.com/googleplay/android-developer/answer/14151465
- New apps and updates must target API 36 from 2026-08-31.
  https://developer.android.com/google/play/requirements/target-sdk
- StrongBox: Android 9+ (API 28), device-dependent, checked with
  `FEATURE_STRONGBOX_KEYSTORE`. Supports P-256 ECDSA and throws
  `StrongBoxUnavailableException` when unsupported (fall back to TEE). It is slower.
  Biometric-bound keys are invalidated on new enrollment by default, and authentication
  goes through BiometricPrompt. https://developer.android.com/privacy-and-security/keystore
- Native passkeys need Credential Manager (androidx.credentials), Android 9+ and Digital
  Asset Links. The relying party must accept the origin `android:apk-key-hash:<sha256>`.
  https://developer.android.com/identity/passkeys/create-passkeys
- Live Updates (promoted ongoing notifications) are only for user-initiated, ongoing,
  time-sensitive activities. Alerts, chat messages and activities started by other
  parties are inappropriate, and the system may demote them.
  https://developer.android.com/develop/ui/views/notifications/live-update
- Android developer verification is enforced from 2026-09-30 in BR, ID, SG and TH, with
  global expansion planned for 2027. ADB install still works.
  https://developer.android.com/developer-verification/guides ,
  https://www.androidauthority.com/android-sideloading-developer-verification-first-wave-rollout-3717921

**Watch, desktop, chat**
- watchOS notification actions: a foreground action runs on the device where it was
  tapped. A background action runs on the notification's target device, the iPhone.
  https://developer.apple.com/documentation/watchos-apps/adding-actions-to-notifications-on-watchos.md
- Safari 17 on macOS Sonoma: web apps added to the Dock get Web Push and badges.
  https://support.apple.com/en-au/104996 , https://developer.apple.com/videos/play/wwdc2023/10120/
- Tauri on macOS needs a Developer ID certificate, notarization and the hardened runtime.
  Its updater uses a separate signing key pair. https://v2.tauri.app/distribute/sign/macos/
- Slack interactive requests are authenticated with HMAC-SHA256 over `v0:ts:body` using
  the app's signing secret, within a 5-minute window. The proof is the app's secret, not
  a user-held key. https://docs.slack.dev/authentication/verifying-requests-from-slack
- Paid Slack plans keep messages for the workspace's lifetime by default.
  https://slack.com/help/articles/203457187
- Teams Universal Actions (`Action.Execute`) send the click to the bot backend, on
  desktop and mobile. https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/universal-actions-for-adaptive-cards/overview
- Office 365 connectors (incoming webhooks) in Teams are retired; Workflows is the
  replacement. https://devblogs.microsoft.com/microsoft365dev/retirement-of-office-365-connectors-within-microsoft-teams/
  The final cutoff date differs across secondary sources and is not verified.

**Hosting, tooling, licensing**
- Railway plans are unchanged: Hobby $5 including $5 usage, Pro $20 including $20. Max
  replicas: Hobby 6, Pro 42. SLAs are Enterprise only.
  https://docs.railway.com/pricing/plans
- Railway still has 4 regions: us-west2, us-east4, europe-west4 (Amsterdam),
  asia-southeast1. https://docs.railway.com/deployments/regions
- Expo plans: Free gives 15 iOS + 15 Android builds per month and 1,000 update MAUs.
  Starter is $19 plus usage. Production is $199. https://expo.dev/pricing ,
  https://docs.expo.dev/billing/plans/
- EAS Update code signing (signed OTA) is available only on the Production and
  Enterprise plans. https://docs.expo.dev/eas-update/code-signing/
- FSL-1.1 allows any use except competing with the producer. Each version converts to
  Apache-2.0 or MIT after 2 years. https://fsl.software/

**Repo state (read 2026-10-28, no URL; checked in the tree)**
- `LICENSE` is MIT and all 170 commits have one author, so relicensing needs no CLA.
- `apps/mobile/app.json` declares an Android package but has no `googleServicesFile`.
- `apps/mobile/modules/device-key` has an `ios/` implementation only.
- `apps/relay/src/adapters` has `apns-sender.ts` and `web-push-sender.ts`, and no FCM
  adapter. The push-subscription kinds are `webpush | apns | apns_activity`.
- The agent persists `relayUrl` (`apps/agent/src/core/relay-url.ts`). Mobile takes its
  origin from the connection, not from a constant.
- The relay/protocol has no `appVersion` or `MIN_APP_VERSION`: the v2 version gate (P-12)
  is not built.
- CI has `ci`, `e2e`, `pg-real` and `release` (npm, `remotectl-v*` tags). There is no
  mobile-release workflow.

## 3. Assumptions

- A1. `setUserAuthenticationParameters(0, AUTH_BIOMETRIC_STRONG)` (API 30+) gives
  per-use biometric authentication on the key. That matches ADR 0017's
  biometry-current-set property, so minSdk is 30 for the signing key. Not re-verified
  against the reference page.
- A2. Expo SDK 58 builds against API 36 by default, or `expo-build-properties` sets it.
  Not verified for SDK 58; verify it in V3-C05.
- A3. The demand evidence that would justify Android or self-host is the owner's call
  (product report 01 owns the kill and demand criteria). This report gives the platform
  cost of each option, not the go decision.
- A4. Per-user cost stays at the v2 estimate (v2-P §4.3, about $0.02/user/month at
  1,000 users per cell). The gateway adds about $5/month, a fixed cost.
- A5. Push volume per active user is under 200 per day. One gateway replica on Hobby
  handles thousands of users. A rough estimate, not measured.
- A6. One developer can carry 2 cells plus the gateway on best-effort on-call. A third
  cell, or any SLA, needs a second person or a paid plan.

## 4. Findings

### F1. The publisher's APNs key is the root of push reach, and it cannot be delegated

A connection serves one team and the JWT names the publisher's Team ID (§2). So any relay
that pushes to the App Store build `dev.ivanbaev.remotecontrol` holds a key of the
publisher's team. Handing a `.p8` to self-hosters gives every self-hoster the power to
push to every install of the app. A topic-specific, production-only key limits the blast
radius to this app, but it is still the publisher's key. So the only sound self-host push
design is a publisher-run **gateway** (v2-P §5.5). It must take metadata and an opaque
`pushBlob` only (D5), so a gateway compromise leaks routing metadata and lets an attacker
send noise. It cannot forge a decision (D7: the agent verifies a device signature).

### F2. The gateway is worth building even without self-host (both branches)

Today the relay holds the `.p8` directly (ADR 0017). With a second cell (v2-P §4.2), the
key would be copied into each cell, and FCM adds a service-account JSON. A gateway gives:

- one credential holder;
- one place to rotate keys;
- one place for per-kind counters (§4 F9).

Cells then hold only a gateway registration key. That is less blast radius for every
deployment, and self-host becomes possible later without new credential plumbing. Cost:
one stateless service (about 300 lines plus adapters already written, `apns-sender.ts`
moves) and one extra hop of latency, tens of milliseconds.

### F3. Self-host contradicts ROADMAP §1 as written

§1 "Never" lists "a user-deployed relay". I1–I4 themselves survive self-host:

- the relay still never decides (I1, ADR 0017);
- it still sees metadata only (I3). A self-hoster sees their own metadata, which is the
  point of self-host.

What changes is the support burden:

- unknown Postgres versions;
- reverse proxies that break WebSocket upgrades;
- RP ID and passkey origin configuration (each self-host domain is a new WebAuthn RP;
  native-app passkeys need that domain in the app's associated domains, which a
  self-hoster cannot add to the App Store build).

Consequence: on a self-hosted relay, the **native iOS app cannot use passkeys for
account sign-in on that domain**. D7 decisions in the native app use the Secure Enclave
key (ADR 0017), not a passkey, so decisions still work. Sign-in must use the pairing
flow, or the PWA on the self-host domain. This must be in the self-host ADR.

### F4. Android is mostly reuse; the long pole is Play, not code

What already carries over:

- the Expo app, phone-core, protocol and crypto are shared (D2, ADR 0017);
- `app.json` already has the package id.

What is missing:

- **(a)** a Kotlin `device-key` module: StrongBox when available, TEE otherwise,
  P-256, auth per use (A1), SPKI exported in pairing msg3 exactly as on iOS;
- **(b)** an FCM v1 sender and `kind: 'fcm'`;
- **(c)** a notification with Deny and Allow actions. Allow opens the app's
  BiometricPrompt and signs, so it never decides from the shade (§1 "Never" holds);
- **(d)** `assetlinks.json` and Credential Manager for passkey sign-in;
- **(e)** a target of API 36.

The closed-test rule (12 testers × 14 days, then up to about 7 days of review) puts the
earliest production launch about 3–4 weeks after the first stable build, whatever the
code speed. An organisation account avoids the tester rule but needs a D-U-N-S number
(v2-P §8 Q8).

### F5. Android Live Updates do not fit approvals

Approvals are started by another party (the agent), are alert-like, and are short. That
is exactly the policy's "inappropriate" list (§2). Use a high-priority FCM data message
and a normal heads-up notification in a dedicated channel. The M4-06 Live Activity
(iOS) has no Android counterpart in 3.0.

### F6. A watch can deliver and Deny, but cannot Allow under D7

A background action runs on the iPhone (§2). The ADR 0017 key is biometry-gated, so the
iPhone would need Face ID while it sits in a pocket. It fails or prompts on the phone,
and either way no Allow comes from the wrist. A foreground watch action would need a
watch-side key with watch-side user verification. watchOS has no Face ID, and wrist
detection plus passcode is not "fresh UV" in D7's sense. Deny needs no UV (D7), so the
mirrored notification's Deny action is safe. It is already free: iOS mirrors the
notification category. The only work is to make sure Deny is a background action that
works while the phone is locked. **Native watchOS app: OUT.**

### F7. Desktop already has a deciding client: the PWA

The web app (apps/web) with a passkey (WebAuthn UV) satisfies D7 for non-deny
decisions. Safari 17+ "Add to Dock" and Chrome/Edge installed PWAs get Web Push. So
"desktop" is a packaging and documentation task (install instructions, an icon,
badges), not a new client. Tauri adds Developer ID signing, notarization, an updater
signing key, and an auto-updater that conflicts with the I4 spirit ("no auto-update").
Electron is the same, plus a 100+ MB runtime. A macOS menu-bar status could come from
`remotectl` itself (it already runs on the dev machine), but it is the same machine that
runs the agent, so it adds little over the terminal. **Tauri/Electron: OUT; menu-bar:
OUT for 3.0.**

### F8. Chat surfaces cannot decide without breaking I1/I3

- **Slack.** A Slack button click reaches our backend signed with the app's secret
  (§2). The authority is Slack's session plus our server, not a key on the user's
  paired device. That violates I1 and ADR 0017 ("the relay never held authority").
  Even Deny via Slack would make the relay originate a decision. Deny is harmless in
  effect, but it adds a decision path that the agent must accept from a non-device
  signer.
- **Slack retention.** Message content posted to Slack is retained by default (§2). So
  only the D5 metadata may be posted: "pending approval on dev X, expires at T", plus a
  deep link. Tool names, paths or commands must never be posted.
- **Teams.** Same verdict. Incoming webhooks are retired (§2), so even notify-only
  needs a Workflows URL or a bot.

Verdict: **notify-only, branch A only** (it is a team feature). The integration posts
the metadata payload and a link to the PWA/app. It must not run on the relay process:
make it a `remotectl` sink or a gateway sink, so the relay gains no outbound
integration surface.

### F9. Observability: v2 §4.9 holds, plus gateway counters

v2-P §4.9 (aggregate counters, `ops_counters`, log-key allow-list, opt-in telemetry) is
still the right design and is not built yet. New for 3.0:

- **gateway counters:** `push_sent{kind,result}`, `push_latency_bucket{kind}`,
  `token_invalid{kind}`, `rate_limited{relay}`, where relay is a hashed registration id;
- **per-cell counters only:** no per-user series;
- **no token, no topic beyond the kind, no IP** in gateway logs. The D19 redaction list
  extends to `deviceToken`, `pushBlob` and `registrationKey`;
- **self-hosted relays send nothing home by default.** The gateway's own counters are
  the publisher's only view, and they are per registration, not per user.

### F10. Version skew is now three-way, and the app cannot be force-updated

The app moves through store review (days), the agent through `npx` (instant, but no
auto-update, I4), and the relay through deploys. Q21 already gives relay N/N-1 for
the protocol major. Missing:

- an `appVersion` in `hello`;
- a `MIN_APP_VERSION` / `MIN_AGENT_VERSION` gate that answers `upgrade_required`
  instead of failing obscurely;
- a skew matrix in CI: relay HEAD against the agent and app at N-1.

Without OTA (signed OTA needs the $199/month plan, §2), a protocol break can strand iOS
users for a review cycle. Expand/contract on wire fields (add, deploy, switch, then
remove one major later) is mandatory. D17 already does this for the schema.

### F11. Cells and residency: the data model is ready, the operations are not

The per-pairing `relayUrl` already exists in the agent, and mobile takes its origin from
the connection (§2). So a second cell needs:

- `cells.json` (v2-P §4.2, P-4);
- a sign-up region choice;
- an export/import to move an account.

The gateway (F2) means a US cell needs no copy of the key. Railway's 4 regions allow a
US East cell. Each cell is a full baseline: Postgres, backups, alerts, a restore drill,
and the staging that ADR 0016 doubles. Multi-region replicas of one cell are unnecessary:
ADR 0012's NOTIFY hub assumes one Postgres, and cross-region NOTIFY latency would break
its liveness timings.

### F12. Branch A vs branch B

| Item | A: v2 shipped (teams) | B: v2 collapsed into 1.x |
|---|---|---|
| Push gateway | IN (prereq for cells, Android, self-host) | IN (Android, key hygiene); smaller |
| Android | IN if demand gate met | IN if demand gate met; it is the main 3.0 reach story |
| Self-host kit | IN behind ADR, FSL-1.1-MIT | OUT; the gateway API stays documented |
| Second cell | On first named US org | OUT |
| Chat notify | IN (team feature), notify-only | OUT |
| Watch Deny | IN (S, verification only) | IN |
| Desktop PWA docs | IN | IN |
| Version gate, mobile release CI | IN | IN |

In branch B, 3.0 for platform is "Android + gateway + release hygiene". That fits one
developer in roughly a quarter alongside the other reports' work.

## 5. Recommendations

**R1. Ship `apps/push-gateway` first (both branches).** Its shape is v2-P §5.5: stateless
`POST /v1/push`, per-relay registration key, kinds `apns|apns_activity|fcm|webpush`.

- Webpush passes through for uniformity, optional.
- Credentials: a topic-specific production APNs key, and a sandbox key for dev builds.
- Per-registration rate limits; returns `410`-style token-invalid back to the relay.
- The relay gains a `GatewayPushSender` behind the existing push port, with
  `PUSH_GATEWAY_URL`. Direct senders stay for local development and tests.
- Rejected:
  - each relay holds the `.p8`: no self-host, key copies per cell;
  - Expo push service: a third party sees tokens and timing, and it adds a dependency
    and its outages. The opaque blob would still be safe, so this is the fallback if
    the gateway slips;
  - Sygnal: Python, Matrix-specific payloads; it is the reference design, not the
    implementation.

**R2. Android as a first-class 3.0 client, conditional on the demand gate.**

- Code: Kotlin device-key (StrongBox, then TEE fallback, minSdk 30 for the key path),
  FCM via the gateway, actionable notification with BiometricPrompt on Allow,
  Credential Manager plus `assetlinks.json`, API 36.
- Start the closed test the day the first stable internal build exists.
- Rejected:
  - Live Updates (F5);
  - Allow from the notification shade without opening the app (§1 "Never");
  - UnifiedPush support (doc-only mention for self-hosters, if self-host ships);
  - a separate native Kotlin app: duplicates phone-core.

**R3. Watch: verify and document Deny from the mirrored notification. No watch app.**
Rejected: watch Allow, which can't meet D7 (F6); a watchOS app with a watch-side key,
which has no fresh UV.

**R4. Desktop = installable PWA.** Add a manifest audit and an install page. Rejected:
Tauri/Electron (signing, notarization, an updater that conflicts with I4); a menu-bar
app (F7).

**R5. Chat = notify-only sink, branch A only, metadata text plus deep link.** It lives
in `remotectl` or the gateway, never in the relay core. Rejected: decisions via chat,
including Deny (F8); posting tool or command details (Slack retention); Teams incoming
webhooks (retired).

**R6. Self-host (branch A only) through ADR "0018-self-hosted-relay"** amending §1. It
ships:

- an official image (the existing Dockerfile) on GHCR;
- a `docker-compose.selfhost.yml` (relay + Postgres 17, `RC_HUB=local`);
- the env reference; push via the publisher gateway with a registration key the
  self-hoster requests;
- a CI smoke test that boots the compose file and runs the harness pairing flow.

Licence: relicense future versions to FSL-1.1-MIT before announcing it. MIT stays
acceptable if the owner does not care about a hosted competitor.

Rejected:

- a Helm chart or Kubernetes operator;
- multi-replica self-host (`RC_HUB=pg` documented as unsupported);
- handing out the `.p8`;
- an enterprise SLA.

**R7. At most 2 cells; a second cell only on a named demand.**

- The EU (Amsterdam) cell is the default.
- A US East cell needs `cells.json`, sign-up region choice and account export/import
  (P-4).
- Rejected: Railway multi-region replicas of one cell (F11); a third cell (A6).

**R8. Release automation: one `mobile-release.yml`.**

- Trigger: an `app-v*` tag. Steps: EAS build (iOS and Android), then `eas submit` to
  TestFlight internal and Play internal.
- The `eas.json` profiles live in the repo, the credentials in EAS and GitHub Secrets.
- A scheduled monthly workflow rebuilds the TestFlight build, because TestFlight builds
  expire after 90 days (v2-P §4.8).
- Stay on the Free plan (15+15 builds per month) until it is exceeded, then Starter.
- Rejected: OTA (signed OTA is $199/month; unsigned OTA is a code-injection channel);
  fastlane (EAS covers it).

**R9. Version gate before the first store release.**

- `hello` carries `appVersion`/`agentVersion`. The relay holds `MIN_*` env values and
  answers `upgrade_required` with a store or `npx` hint.
- A CI skew job runs the harness with the relay at HEAD and the agent at the last
  published `remotectl`.
- Wire changes follow expand/contract across one major.

**R10. Observability = v2 §4.9 plus gateway counters (F9).** No per-user metrics, no
third-party analytics SDK in the app, and Sentry in the app only with
`beforeSend` scrubbing and no breadcrumbs of notification content.

**What 3.0 should NOT contain (platform):**

- a native watchOS app, or watch Allow;
- Tauri/Electron, or a menu-bar app;
- decisions from Slack/Teams;
- Android Live Updates;
- OTA updates;
- multi-region replicas, or more than 2 cells;
- an SLA'd or hosted-enterprise tier;
- Helm/K8s self-host;
- UnifiedPush or F-Droid builds;
- handing out push credentials.

## 6. Risks

| Id | Risk | L | I | Mitigation |
|---|---|---|---|---|
| RK1 | Gateway is a single point of failure for all push across cells and self-hosts | M | H | Stateless, 2 replicas on Railway; relay falls back to polling and WS (D23). Push is a wake-up, not the decision channel |
| RK2 | Gateway compromise leaks routing metadata and enables spam pushes | L | M | D5 opaque blob; topic-specific key; per-registration rate limits; key rotation runbook |
| RK3 | Play closed-test rule delays Android launch by 3–4+ weeks, or recruiting 12 testers fails | H | M | Start at the first stable build; recruit from existing PWA users; org account as fallback (D-U-N-S) |
| RK4 | StrongBox fragmentation or OEM BiometricPrompt bugs cause signing failures | M | M | TEE fallback; attestation logged as a counter only; a device matrix of 3 OEMs in the closed test |
| RK5 | App and relay skew strands iOS users during review after a wire change | M | H | Version gate (R9), expand/contract, N-1 CI job |
| RK6 | Self-host support load swamps one developer | M (A) | H | Branch A only; best-effort community support written in the ADR; compose-only; smoke test |
| RK7 | Self-host native app has no passkey sign-in on the custom domain (F3) | H (A) | M | Pairing-based sign-in plus PWA; documented limitation |
| RK8 | Second cell doubles backup/restore drill and on-call load | M | M | Cap at 2; same compose and runbook per cell; restore drill quarterly per cell |
| RK9 | Expo build quota or plan price changes | L | L | Builds are tag-driven; local `eas build --local` as fallback |
| RK10 | Android developer verification (2027 global) affects sideloaded builds | L | L | Ship via Play only; no APK distribution in 3.0 |
| RK11 | Chat notify integration tempts scope creep into chat decisions | M | H | R5 is written into the self-host/teams ADR as a non-goal; any change needs a new ADR |

## 7. Work items

Ids V3-C01…; size S ≤ 1 day, M ≤ 1 week, L > 1 week for one developer plus an AI executor.
Branch marks: "AB" = both, "A" = only if teams shipped.

| Id | Item | Br | Size | Deps | Acceptance criteria (machine-checkable) |
|---|---|---|---|---|---|
| V3-C01 | `apps/push-gateway`: stateless `POST /v1/push`, kinds apns/apns_activity/fcm, registration-key auth, per-registration rate limit | AB | M | M4-05 done | `pnpm --filter push-gateway test` green. Tests prove: 401 without key; 429 over limit; body over 4 KB → 413; a payload with any field outside `{kind,deviceToken,topic,metadata,pushBlob}` → 400; logs captured in the test contain no `deviceToken`/`pushBlob` value |
| V3-C02 | Relay `GatewayPushSender` behind the push port; `PUSH_GATEWAY_URL` env; direct senders kept for dev | AB | S | C01 | Contract test runs the same push-port suite against direct and gateway senders; harness e2e with the gateway passes; `grep -r "APNS_KEY" apps/relay/src` only in the direct adapter |
| V3-C03 | Gateway deploy and ops: Railway service, 2 replicas, topic-specific production APNs key, sandbox key, key rotation runbook section | AB | S | C01 | `docs/ops/runbook.md#push-gateway` exists with rotate and revoke steps; `/health` returns 200 with `{apns:"ok",fcm:"ok"}` from staging in a recorded CI smoke job |
| V3-C04 | FCM v1 adapter in the gateway (OAuth2 service account, token-invalid mapping) | AB | S | C01 | Unit tests with a fake FCM endpoint: `UNREGISTERED` → `token_invalid`; OAuth token cached and refreshed before expiry (clock-port test) |
| V3-C05 | Android build baseline: `googleServicesFile`, API 36 via `expo-build-properties`, `eas.json` android profiles, the build runs | AB | S | — | `npx expo config --type public` shows `targetSdkVersion: 36`; `eas build -p android --profile preview --local` exits 0 in CI (or the documented EAS job id is recorded) |
| V3-C06 | Kotlin `device-key` module: StrongBox then TEE fallback, P-256, per-use biometric auth, SPKI export identical in format to iOS | AB | M | C05 | Instrumented test on an emulator: generate, sign, verify the signature with `packages/crypto` verifier over a canonical decision; `isStrongBox` reported; a key added without biometric enrolment fails with a typed error. `phone-core` contract tests pass for both platforms |
| V3-C07 | `kind:'fcm'` subscriptions in the relay store and pairing; app registers its FCM token | AB | S | C02, C04, C05 | Migration adds the kind; I3 schema check passes; e2e harness test registers an `fcm` subscription and the gateway fake receives exactly `{t,rid,dev,exp}` plus the blob |
| V3-C08 | Android actionable notification: channel, Deny (background) and Allow (opens app, BiometricPrompt, sign) | AB | M | C06, C07 | Maestro/Detox flow: Deny from the shade sends a deny with no UV; Allow from the shade launches the app and the decision is not sent until the biometric stub succeeds; test fails if any non-deny decision is sent without a signature |
| V3-C09 | Android passkey sign-in: Credential Manager, `/.well-known/assetlinks.json` served by the relay, RP accepts `android:apk-key-hash:` origin | AB | M | C05 | Relay test: assetlinks JSON matches the release and upload cert SHA-256 from env; WebAuthn verify accepts the configured apk-key-hash origin and rejects any other |
| V3-C10 | Play closed test: personal account, 12+ testers opted in, 14-day timer started; production application | AB | S (+14 d wait) | C08 | Play Console track `closed` shows ≥12 opted-in testers (screenshot or API output recorded in the runbook); production access granted is recorded with a date |
| V3-C11 | `mobile-release.yml`: `app-v*` tag → EAS build iOS+Android → submit TestFlight internal and Play internal; monthly TestFlight refresh schedule | AB | M | C05, M4-08 | The workflow file passes `actionlint`; a dry run on a test tag completes both builds; the schedule job exists with `cron`; no secret value appears in the repo (`gitleaks` clean) |
| V3-C12 | Version gate: `appVersion`/`agentVersion` in `hello`, `MIN_APP_VERSION`/`MIN_AGENT_VERSION`, `upgrade_required` frame; app and agent show an upgrade hint | AB | S | — | Protocol schema test; relay test: a hello below the minimum gets `upgrade_required` and close 4426 (or the chosen code); agent CLI test prints the `npx` upgrade line |
| V3-C13 | Skew CI job: relay HEAD against the last published `remotectl` and the previous app protocol fixtures | AB | S | C12 | `.github/workflows/ci.yml` job `skew` installs `remotectl@latest` from npm and runs the harness pairing+decision suite green |
| V3-C14 | Watch Deny verification: the notification category marks Deny as a background action that works on a locked phone; doc for watch behaviour | AB | S | M4-05 | Unit test on the category config: Deny has no `.foreground`/`.authenticationRequired`, Allow has `.foreground` + `.authenticationRequired`; simulator test where Deny from a locked state reaches the agent |
| V3-C15 | Desktop PWA install: manifest audit, install page for Safari Dock / Chrome, badge on pending count | AB | S | — | Lighthouse PWA "installable" check passes in CI; `apps/web` e2e asserts the manifest has `display: standalone` and icons at 192/512 |
| V3-C16 | Observability for the gateway and relay: v2 §4.9 counters, gateway `push_sent{kind,result}`, redaction list extended | AB | M | C01 | Test feeds a log with token/blob/registration key and asserts pino output redacts all three; `/metrics` (or `ops_counters`) has no label whose value set exceeds the kinds/results enums |
| V3-C17 | ADR 0018 self-hosted relay: amends §1 "Never", support stance, passkey limitation (F3), gateway registration, licence | A | S | C01 | `docs/adr/0018-*.md` exists; ROADMAP §1 references it; a docs-lint check finds "user-deployed relay" only with the ADR reference |
| V3-C18 | Self-host kit: GHCR image on `relay-v*` tags, `docker-compose.selfhost.yml`, env reference, registration-key request flow | A | M | C17, C02 | CI job boots the compose file, waits for `/health` 200, runs the harness pairing and a push via the gateway fake; the image is signed (cosign) and has an SBOM attached |
| V3-C19 | Licence change to FSL-1.1-MIT for future versions (if owner Q1 says so) | A | S | owner Q1 | `LICENSE` text matches fsl.software FSL-1.1-MIT; `package.json` `license` fields agree; README states the change date and the MIT-licensed last version |
| V3-C20 | Cells: `cells.json`, sign-up region choice, account export/import (P-4 completion) | A | L | C02 | Harness test creates an account on cell EU, exports, imports on cell US, and re-pairs with `relayUrl` updated; old cell rows deleted (count 0) |
| V3-C21 | Chat notify sink (Slack Workflows/webhook, Teams Workflows), metadata-only text and deep link, in `remotectl` | A | M | owner Q-chat | Unit test: the rendered message contains only `dev`, `exp` and the link; a test fails if any field from the decrypted request appears; no Slack/Teams code under `apps/relay` (`grep` check) |

Critical path:

- branch B: C01 → C02/C04 → C05 → C06 → C07 → C08 → C10 (wait) → production;
- C11, C12 and C13 run alongside;
- branch A adds C17 → C18 and, on demand, C20.

## 8. Open questions for the owner

| Id | Question | Default if unanswered |
|---|---|---|
| OQ1 | **Self-host and licence.** Ship a self-host kit in 3.0, and relicense to FSL-1.1-MIT before announcing it? | Self-host only in branch A, after the gateway. Keep MIT until self-host is announced; then FSL-1.1-MIT for new versions |
| OQ2 | **Android in 3.0, and the Play account type.** | Yes if the demand gate (report 01) is met; personal account; closed test started at the first stable internal build |
| OQ3 | **Push gateway trust model.** Publisher-hosted, open source, with a `PUSH_GATEWAY_URL` override, and self-hosters request a registration key by hand? | Yes; a free registration key per self-host, revocable, rate-limited; no self-run gateway for the App Store build (it is impossible without the publisher key) |
| OQ4 | Trigger for a second (US) cell | EU only until a named paying user or org needs US residency |
| OQ5 | Chat notify integration (Slack/Teams) at all? | Branch A only, notify-only, after Android |
| OQ6 | Accept the Expo Starter plan ($19/month) if Free build quotas run out? | Yes; OTA stays off regardless |
| OQ7 | Publish a status page and an SLO statement with no SLA? | Yes: a best-effort statement, UptimeRobot public page, no SLA |

## 9. Sources

- APNs token auth: https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns.md
- watchOS notification actions: https://developer.apple.com/documentation/watchos-apps/adding-actions-to-notifications-on-watchos.md
- Safari web apps on Mac: https://support.apple.com/en-au/104996 ; https://developer.apple.com/videos/play/wwdc2023/10120/
- FCM v1 migration: https://firebase.google.com/docs/cloud-messaging/migrate-v1
- Expo FCM credentials: https://docs.expo.dev/push-notifications/fcm-credentials/
- Expo pricing and plans: https://expo.dev/pricing ; https://docs.expo.dev/billing/plans/
- EAS Update code signing: https://docs.expo.dev/eas-update/code-signing/
- Play closed testing: https://support.google.com/googleplay/android-developer/answer/14151465
- Play target API: https://developer.android.com/google/play/requirements/target-sdk
- Android Keystore / StrongBox: https://developer.android.com/privacy-and-security/keystore
- Android passkeys: https://developer.android.com/identity/passkeys/create-passkeys
- Android Live Updates: https://developer.android.com/develop/ui/views/notifications/live-update
- Android developer verification: https://developer.android.com/developer-verification/guides ; https://www.androidauthority.com/android-sideloading-developer-verification-first-wave-rollout-3717921
- Tauri macOS signing: https://v2.tauri.app/distribute/sign/macos/
- Slack request signing: https://docs.slack.dev/authentication/verifying-requests-from-slack
- Slack retention: https://slack.com/help/articles/203457187
- Teams Universal Actions: https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/universal-actions-for-adaptive-cards/overview
- Teams connectors retirement: https://devblogs.microsoft.com/microsoft365dev/retirement-of-office-365-connectors-within-microsoft-teams/
- Railway pricing and regions: https://docs.railway.com/pricing/plans ; https://docs.railway.com/deployments/regions
- FSL: https://fsl.software/
- Sygnal: https://github.com/matrix-org/sygnal
- UnifiedPush on F-Droid: https://f-droid.org/2022/12/18/unifiedpush.html
- Internal: ROADMAP §1, §2 (D2, D5, D7, D15–D17, D19, D23), §4 M4, §6 Q21; ADR 0012, 0016, 0017;
  v2/reports/03-platform.md §4.2, §4.3, §4.6–§4.9, §5.5, §8; v2/SYNTHESIS.md; v2/ROADMAP-v2.md.
