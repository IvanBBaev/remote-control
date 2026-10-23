# v2 / 03 — Platform, scale, distribution and observability

Role: Backend/Platform engineer. Status: 2026-10-24. Inputs: `../00-brief.md`,
`../../reports/03-backend.md`, `../../reports/06-platform.md`, ROADMAP D4, D15–D17,
ADR 0011, 0012, 0016 (and 0017 for the native app). Facts fetched on 2026-10-24 carry a
URL; everything else is an assumption (section 3). Nothing here is a decision.

## 1. Summary

1. The relay is not the scaling problem. At 1,000 users (about 900 concurrent sockets) one
   cell of 2 replicas + 1 Postgres costs about $19/month, about $0.02 per user; fixed costs
   (Apple $99/yr, domain) dominate until several hundred users.
2. Scale in **cells**, not in one ever-larger cluster. A cell = a Railway service (2–4
   replicas, `RC_HUB=pg`) + its own Postgres + its own domain. Railway caps a domain at
   10,000 concurrent connections, so a cell tops out at about 3,000 users x 3 devices;
   the next user goes to a new cell. `PgNotifyHub` (ADR 0012) stays, bounded to <= 4 replicas.
3. Regions are about data residency, not latency. An approval tolerates seconds, so a
   US user on the EU cell loses nothing visible. Railway multi-region replicas are rejected:
   it routes to the nearest region, so a phone and its agent would land in different
   regions and every frame would cross the Postgres NOTIFY path.
4. Teams need an additive schema (`orgs`, `memberships`, `machine_grants`, signed
   policy blobs) with the user as the tenant key for personal accounts. The relay stores
   a signed policy it cannot interpret; the agent enforces it (I3, I4).
5. Self-host is feasible from the existing image, but **native iOS push breaks**: the APNs
   `.p8` key belongs to the app publisher. The fix is a small stateless **push gateway**
   (metadata-only payloads), which also simplifies the hosted cells.
6. Distribution: TestFlight (10,000 external testers) then App Store; Play needs a 12-tester
   x 14-day closed test for personal accounts. Android has no Live Activity equivalent we
   have verified; desktop = installable PWA; the watch can only show mirrored notifications,
   and it cannot safely **Allow** because D7/ADR 0017 needs a fresh Face ID signature.
7. The biggest new security surface is the mobile release channel: an OTA JS update (EAS
   Update) can replace the code that holds keys and signs decisions. Ship it code-signed
   or not at all.
8. Observability stays metadata-only by construction: aggregate, per-cell counters with
   no user or device labels, an allow-listed log schema enforced by a test, opt-in client
   telemetry. Railway offers no custom metrics or log drain, so the relay keeps its own
   hourly counter table.

## 2. Verified facts

Railway (fetched 2026-10-24):

- F1. Plans: Free $0 ($1 credit), Hobby $5 (incl. $5 usage), Pro $20 (incl. $20 usage),
  Enterprise custom. Usage: RAM $10/GB/month, CPU $20/vCPU/month, egress $0.05/GB, volume
  $0.15/GB/month; builds are free. https://docs.railway.com/pricing/plans
- F2. Max replicas per service: Trial 2, Free 1, **Hobby 6**, Pro 42, Enterprise 50. Hobby
  per-service ceiling 48 GB RAM / 48 vCPU / 5 GB volume; Free 0.5 GB RAM / 1 vCPU. Same URL.
- F3. Replicas can be assigned to different regions in the service settings; with several
  regions "public traffic goes to the nearest region, then is randomly distributed among
  that region's replicas"; **sticky sessions are not supported**. Scaling is a staged change
  that applies without a full redeploy; removed replicas are drained gracefully.
  https://docs.railway.com/reference/scaling
- F4. Regions: `us-west2` (California), `us-east4-eqdc4a` (Virginia),
  `europe-west4-drams3a` (Amsterdam), `asia-southeast1-eqsg3a` (Singapore).
  https://docs.railway.com/deployments/regions
- F5. Private networking: encrypted Wireguard tunnels, internal DNS, services must be in
  the same project environment; each environment has an isolated network. The page says
  nothing about cross-region behaviour or its cost.
  https://docs.railway.com/reference/private-networking
- F6. Usage limits: soft limit (email) and hard limit (takes workloads offline), reminders at
  75/90/100 %; the minimum hard limit is $10; the compute limit can be removed.
  https://docs.railway.com/reference/usage-limits
- F7 (carried from 03-backend/06-platform, fetched 2026-10-12): 10,000 concurrent
  connections and ~11,000 requests/s per domain; WebSockets are exempt from duration and
  inactivity limits; no log drain; metrics are CPU/RAM/disk/network only, 30 days.
  https://docs.railway.com/networking/public-networking/specs-and-limits ,
  https://docs.railway.com/reference/metrics , https://docs.railway.com/reference/logging

Postgres:

- F8. `NOTIFY`: delivered only on commit, in commit order; if the queue (8 GB standard)
  fills, **transactions calling NOTIFY fail at commit**; a session that LISTENs and then sits
  in a long transaction blocks cleanup; `pg_notification_queue_usage()` returns the fraction
  used. https://www.postgresql.org/docs/current/sql-notify.html
- F9. A 2025 write-up reports that a NOTIFY inside a transaction takes a database-wide lock
  at commit, serialising commits under many concurrent writers; a DBOS rebuttal reaches 60K
  writes/s on one server with an optimised design; a later mailing-list proposal still
  describes the lock in `PreCommit_Notify` as a bottleneck. Whether a core fix landed is
  unverified. https://recall.ai/blog/postgres-listen-notify-does-not-scale ,
  https://dbos.dev/blog/postgres-listen-notify-scalability ,
  https://hackorum.dev/topics/51945

Stores and tooling:

- F10. Apple Developer Program: 99 USD per membership year.
  https://developer.apple.com/programs/whats-included/
- F11. TestFlight: up to 10,000 external testers, up to 100 internal testers, builds
  testable for 90 days; the first build added to an external group goes to Beta App Review.
  https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview
- F12. Google Play Console: US$25 one-time registration fee.
  https://support.google.com/googleplay/android-developer/answer/6112435
- F13. Personal developer accounts created after 2023-11-13 must run a closed test with at
  least 12 testers opted in continuously for 14 days, then apply for production access
  (review usually <= 7 days). https://support.google.com/googleplay/android-developer/answer/14151465
- F14. FCM: normal-priority messages may be delayed when the app is in the background; "FCM
  attempts to deliver high priority messages immediately even if the device is in Doze
  mode". https://firebase.google.com/docs/cloud-messaging/customize-messages/setting-message-priority
- F15. EAS (Expo): Free = 15 Android + 15 iOS builds and 1,000 update MAUs (reset period not
  stated); Starter $19/month + usage ($45 build credit, 3,000 MAUs); Production $199/month.
  https://expo.dev/pricing

## 3. Assumptions

- A1. Per-user load: 3 devices, ~30 % online at any time, ~200 envelopes/day, ~30 MB/month
  egress per user (including the live feed). Idle socket ~30 KB; replica baseline ~0.25 GB
  RAM, 0.1 vCPU. All cost numbers below are modelled from F1 and A1, not measured.
- A2. APNs: alert payload <= 4 KB, `apns-priority` 10 for alerts, token auth with a `.p8`
  key valid for a team (from general knowledge; the fetch returned only the page title).
  FCM data payload limit 4 KB (not on the fetched page). Both must be checked in M4-05.
- A3. Phone and agent are both close to the relay in normal use; cross-region RTT
  (~100–150 ms) is invisible next to human decision time.
- A4. Railway Postgres is a single instance without automatic failover (06 saw no HA
  mention). A cell's availability equals its database's.
- A5. Android 13+ requires the runtime permission `POST_NOTIFICATIONS`; a high-priority FCM
  data message can start a foreground notification. Android's Live Updates / ongoing
  notification features were not verified.
- A6. An Apple Watch has no Face ID; a Secure Enclave key with the "biometry, current set"
  access control (ADR 0017) cannot be exercised from the watch. Actionable notifications
  mirror to a paired watch by default.
- A7. Apple App Review accepts an app that requires an account and a user-run companion
  process if a demo/review path is supplied; this is not verified and is a release risk.
- A8. Expo supports code signing of EAS Update bundles (not verified here).
- A9. Postgres `NOTIFY` commit serialisation is irrelevant below ~hundreds of NOTIFY
  commits/s sustained; a cell at 1–3k users peaks only during reconnect storms (A1 x
  deploy). To be measured (WI-1).

## 4. Findings

### 4.1 What `PgNotifyHub` costs per replica

Reading ADR 0012 against A1:

- Membership is **broadcast**: every attach/detach is a NOTIFY on `rc_hub` heard by every
  replica, and each replica keeps a proxy for every remote device. Memory is O(devices in
  the cell) per replica, notify fan-in is O(R) per event. Heartbeats are R x R every 5 s.
  All trivial at R <= 4 and a few thousand devices.
- Traffic is **random-replica**: with no stickiness (F3) a phone and its agent sit on the
  same replica with probability 1/R, so (R-1)/R of frames cross Postgres (50 % at R=2, 75 %
  at R=4). Cost per cross-replica frame: one NOTIFY commit plus a chunked base64 expansion
  for frames > 7,900 bytes (ADR 0012). At 1,000 users and ~200 envelopes/day this is well
  under 1 frame/s average. The ceiling is the reconnect storm: a deploy re-attaches all
  sockets, so ~900 (1k users) to ~2,700 (3k users) `on` NOTIFY commits within the 0–3 s
  jitter window. That is the one thing to load test (F9).
- A stuck LISTEN session can fill the queue and make every NOTIFY commit fail (F8): the
  failure mode is cell-wide. ADR 0012 relies on the health check; nothing alerts on
  `pg_notification_queue_usage()` yet.
- Rate limits are per replica and give up to R x each limit (ADR 0016). Acceptable at R <= 4,
  not a quota system.
- Deploys: Hobby allows 6 replicas (F2); 4 is the practical hub bound, 6 the plan bound.

Conclusion: the hub is sound for one cell; it is the wrong tool to stretch past ~4
replicas or ~10k sockets. That limit coincides with Railway's 10,000-connection domain
cap (F7), so the same boundary is hit from two sides.

### 4.2 Cells instead of regional replicas

Railway's multi-region replicas (F3) route each client to the **nearest** region. A phone in
the US and an agent in Amsterdam would hit different replicas, so the pair would always be
cross-region, while all replicas share one Postgres in one region. That gives the worst of
both: no data locality, cross-region database latency on every membership event, and
unverified private-network behaviour across regions (F5 is silent).

A cell fixes this: the account is created in one cell; pairing hands the client and the agent
the cell's hostname; every device of that user talks to that host. No global router and no
cross-cell traffic. The cost is that a user lives in one cell and moving is an export/import.
That is acceptable for 2.0 (nobody moves).

What a cell needs that v1 does not have:
- A cell-aware client: `relayUrl` must be stored per pairing, not baked at build time (the
  PWA is served by the relay itself, so it is already same-origin; the native app and the
  agent store a URL).
- Account creation picks a cell: self-declared region at signup (default EU) or "next cell with
  capacity"; capacity = connected devices / 10,000 x safety factor 0.5.
- A static `cells.json` in the repo (name, host, region, status) read by CI and the status
  page. No directory service until there are more than 3 cells.

### 4.3 Cost per user

Modelled from F1 and A1; Hobby plan, region Amsterdam. The Hobby fee of $5 includes $5
of usage, so the bill is max($5, usage) (as in 06 section 5.7).

| Cell | Relay | Postgres | Egress | Volume+backup | Usage | Per user |
|---|---|---|---|---|---|---|
| Owner only (1 replica) | 0.25 GB, 0.05 vCPU = $3.5 | 0.2 GB + CPU = $2.5 | $0.05 | $0.10 | ~$6.2 | n/a |
| 1,000 users (2 replicas) | 2 x (0.3 GB, 0.1 vCPU) = $10 | 0.5 GB, 0.1 vCPU = $7 | 30 GB = $1.5 | $0.6 | ~$19 | ~$0.02 |
| 3,000 users (3 replicas) | 3 x (0.35 GB, 0.15 vCPU) = $19.5 | 1 GB, 0.3 vCPU = $16 | 90 GB = $4.5 | $1.5 | ~$42 | ~$0.014 |
| Second cell (EU + US) | + a full baseline ($6–7 minimum) | | | | | |

Observations:
- RAM per extra user is negligible (30 KB x 3 devices); cost steps with replicas and Postgres
  size, not with users. The biggest lever is Postgres RAM, then replica count.
- APNs and FCM have no per-message charge to us (assumption A2; not on a fetched page).
- Fixed non-Railway costs: Apple $99/yr = $8.25/month (F10), Play $25 one-time (F12), domain
  ~$1.25/month, EAS Free tier covers 15+15 builds (F15). With 10 users the whole product
  costs about $16/month, all but ~$6 of it fixed.
- A Railway hard limit (F6, minimum $10) protects the bill but takes the cell offline: it is
  an abuse circuit breaker, not an operating setting. Set it at 3x expected usage.
- The hosted free tier needs caps, not a price: 10 devices (existing), 5 agents, 10 GB/month
  egress per account.

### 4.4 Abuse limits beyond v1

v1 has per-replica fixed-window limits (ADR 0016), 10 devices per user, invite-only signup
(M0-09). For hosted use beyond a named circle:
1. **Signup:** keep invite codes (each code = one account, issued by the owner or by an
   existing user with a quota of 3). Open signup is a decision, not a default (Q4).
2. **Pre-auth cost:** unauthenticated WebSocket upgrades are already rejected as HTTP 401
   before a socket exists (03 section 5.1). Add per-IP connection-attempt limits at the
   relay, keyed on `X-Real-IP` (F7 lists the header; verify it is set by Railway's proxy and
   not client-spoofable) and cap login/pairing attempts per code.
3. **Per-account quotas, enforced in the hub and counted in memory:** frames/s (existing),
   bytes/day, pending requests per machine (e.g. 20), `startSession` commands/hour, push
   dispatches/hour (protects APNs/FCM reputation).
4. **Push abuse:** a relay-authenticated push only (ADR 0017 already requires it);
   gateway-side per-relay and per-device-token rate limit (section 5.5).
5. **Cluster-wide limits:** a Postgres counter table is rejected (a write per request, ADR
   0016); accept R x limits with R <= 4 and set limits at 1/R of the true bound.
6. **Kill switch:** `users.disabled_at` already exists; add `POST /admin/disable` that also
   closes sockets via the hub. Per-account egress is observable (section 5.6) and
   enforceable at the quota level.

### 4.5 Multi-tenant / team data model

v1: tenant = user; machines (`devices` of kind agent) belong to one user; phones are
that user's too. A team adds three relations. Constraints from the invariants:
the relay must not become the policy authority (I4) and cannot read policy (I3).

```
orgs(id, name, created_at, disabled_at)
memberships(org_id, user_id, role in ('owner','admin','approver','viewer'), created_at, revoked_at)
machine_grants(machine_device_id, org_id, grant_user_id nullable, scope, created_at, revoked_at)
org_policies(org_id, version, signed_blob bytea, signer_user_id, created_at)   -- opaque to relay
```

- `user_id` stays the key everywhere; `org_id` is nullable on routing tables. A personal
  account is a degenerate org of one, so no data migration: the migration is additive and
  `org_id IS NULL` means personal.
- **Routing**: `to`/fan-out checks move from "same user" to "same user OR grantee of the
  machine in this org" (03 section 5.5 rule). The hub index stays `userId -> devices`;
  for team machines the hub resolves the grantee set per machine (an in-memory cache
  invalidated by a hub event). This is the one core change, in `RelayRouter`.
- **Keys**: each approver already has a Noise pairing with each agent they approve for, so
  multiple phones approving one machine means multiple pairings, not shared keys. The agent
  encrypts each request once per authorised phone session (O(approvers) AEAD, trivial).
- **Policy**: allow-lists and quorum rules are a document signed by an org admin key
  (device key or passkey, product decision); the relay stores and serves the opaque blob; the
  agent verifies the signature against pinned admin keys and enforces the quorum itself.
  A relay compromise can withhold a policy (fail closed: agent keeps the last good version
  and denies if none) but cannot forge one.
- **Audit**: `audit_log` gains `org_id`; entries stay metadata-only (event, actor device,
  request id, decision class). An exportable audit trail is a view over the same table.
- **Isolation**: every query is scoped by `(org_id, user_id)` in a repository layer;
  Postgres row-level security is rejected for one developer (a second authorisation
  mechanism to test and operate); instead a **cross-tenant property test** (random
  two-tenant workloads, assert no row or frame crosses) runs in `pg-real`.
- **Deletion**: org deletion cascades memberships and grants; users keep personal data.
  Offboarding a member revokes their grants and their pairings, closes their sockets (ADR
  0009 revocation path).

### 4.6 Self-host

- Already true: a Dockerfile image (D16), `RC_HUB=local` default, migrations on boot (D17),
  a compose file for Postgres (06). A self-hoster needs Docker, Postgres, a domain with
  TLS (WebAuthn RP ID, secure context), VAPID keys.
- Not true: **native push.** APNs tokens are scoped to the publisher's team and bundle id,
  and the `.p8` is a team secret (ADR 0017). A self-hosted relay cannot push to the
  App-Store app, and handing out our `.p8` is not an option. FCM has the same shape with
  the Firebase project.
- Options: (a) self-hoster builds and signs their own app (needs their own $99, poor); (b)
  they use PWA/Web Push only (works, loses Live Activities); (c) a **push gateway** run by
  the publisher. The Matrix ecosystem uses this pattern (a push gateway holds the app keys;
  homeservers call it), assumed from general knowledge, not fetched.
- Recommended (c): `apps/push-gateway`, a tiny stateless service. Relay -> gateway: `POST
  /v1/push {kind, deviceToken, topic, metadata, pushBlob}` authenticated by a per-relay
  registration key; the gateway holds the `.p8` and FCM credentials and forwards. What it
  sees: device tokens and the same metadata + opaque `pushBlob` that APNs already sees
  (ADR 0017, D5), never plaintext, never authority (I1, I3, I4 unchanged). Hosted cells use
  the same gateway, so there is one code path and one place for the Apple/Google keys.
- Cost of (c): a single point of failure for native push of every installation and a new
  trust party for self-hosters (they learn the gateway sees device tokens). Mitigations:
  publish the gateway source, document exactly what crosses, allow a gateway URL override
  (own gateway + own build), and degrade to Web Push/socket-only on gateway failure.
- Licence is an owner decision (Q3); the choice affects whether a hosted competitor can
  take the relay.

### 4.7 Android, desktop, watch

**Android.** Expo already targets Android (ADR 0017). Needs: FCM (high-priority data message
as a wake-up, F14), `POST_NOTIFICATIONS` (A5), notification action buttons, Android Keystore/
StrongBox key for the decision signature, Play listing. Play friction is process, not
code: the 12-tester x 14-day closed test (F13) adds at least 3 weeks before production
if the account is personal. Start it as soon as the Android build is stable. Android has no
Live Activity: ongoing notification with actions is the closest (A5, unverified); do not
promise parity.

**Desktop.** The PWA is installable on desktop browsers and gets Web Push; the relay
is the same-origin host. A native shell (Tauri/Electron) adds a signing/notarisation and
auto-update pipeline for one developer, and no capability the PWA lacks except a tray icon.
`remotectl` already runs as a user service on the machine where the work happens; a tray
icon belongs to it as an optional `remotectl status --tray` later. Reject a separate desktop
client for 2.0.

**Watch.** Actionable notifications mirror to a paired Apple Watch by default (A6). The
watch has no Face ID, so a fresh-biometry Secure Enclave signature (ADR 0017) is impossible
there. A watch **Allow** would need a weaker, separate key class (wrist-detect + passcode)
and an agent-side policy that accepts it only for low-risk tools. That is a policy
decision tied to the risk-scoring theme, not a platform task. Safe default: the watch shows
the mirrored notification with **Deny** and "Open on iPhone". A native watchOS app is
deferred.

### 4.8 Release pipelines

Three artefacts with three cadences:

| Artefact | Channel | Cadence | Gate |
|---|---|---|---|
| Relay | Railway GitHub integration, "Wait for CI" (D16) | every merge | `pnpm check` + pg-real + image scan; migrations forward-only (D17) |
| `remotectl` | npm trusted publishing, tag-driven (ADR 0003) | weekly | agent-os matrix on Node 22/24 (ADR 0011) |
| Mobile | EAS Build + `eas submit` -> TestFlight / Play internal | monthly, store review lag | device run + privacy gate |

The new problem is **version skew**. The store review lag (days) means old apps meet new
relays and vice versa. Rules for 2.0:
- The relay supports the current and previous protocol major (03 section 5.10, D4 of the
  protocol); extend it to apps: `hello` carries `appVersion` and the relay answers
  `upgrade_required` with a store link below a `MIN_APP_VERSION` env value.
- Migrations stay expand/contract: a column is dropped only after the last supported app
  and agent version stopped using it.
- Mobile pipeline (new `mobile-release.yml`, tag `app-v*`): EAS build iOS + Android ->
  `eas submit` to TestFlight internal group and Play internal track -> manual promotion to
  external / closed -> production. TestFlight builds expire after 90 days (F11): a
  scheduled re-upload keeps the beta group alive; the first external build needs Beta App
  Review (F11), so the first TestFlight external invite is a lead-time item.
- Free EAS covers 15 builds per platform (F15); a monthly cadence fits. If the free quota
  runs out, building on a GitHub macOS runner is the fallback.
- **OTA (EAS Update).** It lets us ship JS fixes without review, and also lets anyone with
  our Expo account replace the code that holds the decision key. That makes the Expo
  account a trust root for I4. Options: (1) no OTA in production, only store releases (safe,
  slow); (2) OTA with code signing, signing key held offline (A8). Recommend (1) for 2.0.0,
  revisit with (2) once store lag actually hurts.
- Supply chain: the existing provenance and SHA-pinned actions practice (06) carries over;
  add `expo-doctor` and a lockfile-diff review for native dependencies (Swift targets are in
  the repo, ADR 0017).

### 4.9 Observability with the metadata-only promise

Current state: pino with redaction, Sentry (scrubbed) on the relay only, `GET /metrics` admin
JSON, UptimeRobot on `/health`, audit log (M0-26, M1-13). Railway gives no custom metrics
and no log drain (F7), 7-day logs on Hobby (06).

Needs for cells and teams:
1. **Aggregate counters only.** Labels allowed: `cell`, `event`, `kind`, `result`. Never
   `userId`, `deviceId`, `machine`, `session`. Rationale: per-user time series are a
   metadata profile of when a person works, which the product tells users it does not
   collect beyond routing.
2. **Hourly persistence.** Railway keeps no app metrics (F7), so the relay writes
   counters to an `ops_counters(hour, cell, name, value)` table and prunes after 90 days.
   Grafana/Prometheus can come later if there is a second developer; one developer reads
   a weekly summary.
3. **SLIs that matter:** connect success rate; envelope forward latency (relay-side,
   p50/p99); push dispatch result by kind (webpush/apns/fcm); reconnect rate per hour
   (storm detector); hub lag; `pg_notification_queue_usage()` (F8) alert at 25 %; sockets
   vs the 10,000 cell cap (alert at 50 %).
4. **Log schema allow-list.** A test generates one request of every type and asserts that
   every log line's keys are in a closed set (extends the M0-22 privacy gate), instead of
   relying only on redaction paths.
5. **Client telemetry is opt-in** and carries app version, OS version, crash class; the
   Sentry mobile SDK is configured with `beforeSend` that drops breadcrumbs, request bodies,
   URLs with query strings. Pairing codes and invite codes appear in URLs and must be scrubbed
   (existing relay scrubbing is the model).
6. **Per-tenant usage** for any future billing is derived from the same counters at
   org level (bytes, requests, devices), never from payloads.
7. **Cell status page:** a static page from `cells.json` plus UptimeRobot results; one
   incident sentence is enough.

## 5. Recommendations

### 5.1 Hub and scale
Keep `PgNotifyHub` for 2–4 replicas inside a cell. Scale beyond that by adding a cell.
Add the queue-usage alert and a staging 4-replica soak before relying on it.
Rejected: (a) Redis pub/sub (D15 stands; a second service for no gain at this size);
(b) a dedicated stateless-edge + hub tier (a rewrite justified only above ~10k concurrent
sockets, which one cell cannot reach anyway); (c) consistent-hash routing in an external
load balancer (Railway has no sticky sessions, F3; a self-run LB adds cost and an ops
surface); (d) one big replica count (blocked by the 10,000-connection cap, F7).

### 5.2 Regions
One EU cell now (D16 region). A second cell is added when a real user needs another
region for residency or when a cell reaches 50 % of its cap, whichever first.
Rejected: Railway multi-region replicas on one database (section 4.2); cross-region
Postgres read replicas (not offered as a verified primitive, writes are the hot path).

### 5.3 Teams
Additive schema in section 4.5, enforced in `RelayRouter` and the repository layer, policy
signed and agent-enforced. Rejected: relay-side policy engine (makes the relay an
authority, breaks I4); Postgres RLS (two authorisation systems for one developer); a
shared team key (breaks per-device revocation and the Noise pairing model).

### 5.4 Cost and plan
Stay on Hobby per cell. Revisit Pro ($20 incl. $20 usage, F1) when a cell exceeds ~$40
usage (it then costs about the same and adds seats/support, assumed from the plan names).
Set the hard limit at 3x expected usage, alert at 1.5x.

### 5.5 Push gateway and self-host
Build `apps/push-gateway` (Fastify, stateless, no database) and route all APNs/FCM
through it, hosted and self-hosted alike; ship `deploy/selfhost/compose.yml` and a
"Self-hosting" doc that states what the gateway sees. Rejected: giving self-hosters the
`.p8`; "self-host = PWA only" as the sole option (keeps the Web Push path but loses the
native app that the owner prioritised in ADR 0017); a Cloudflare Worker gateway (viable
but a second platform to operate).

### 5.6 Distribution
Android via Expo + FCM with the Play closed test started early; desktop = PWA; watch =
mirrored notifications with Deny only; no OTA in production at 2.0.0; mobile release workflow
as in section 4.8. Rejected: Tauri/Electron desktop client; watch Allow without a policy
decision; OTA by default.

### 5.7 Observability
Aggregate counters + `ops_counters` table + log-key allow-list test + opt-in client
telemetry (section 4.9). Rejected: a hosted APM with per-request traces (payload-adjacent
data leaves our infrastructure); per-user dashboards (metadata profile).

## 6. Risks

| # | Risk | L | I | Mitigation |
|---|---|---|---|---|
| R1 | NOTIFY commit serialisation (F9) limits the reconnect storm | M | M | WI-1 soak with 4 replicas; jitter widened to 0–10 s if p99 attach > 2 s |
| R2 | Stuck LISTEN fills the queue, NOTIFY commits fail cell-wide (F8) | L | H | alert at 25 % usage; replica restarts on a stuck listener; WI-2 |
| R3 | Cell reaches the 10,000-connection domain cap (F7) | L | H | alert at 50 %; new signups go to the next cell |
| R4 | Railway region or Postgres outage takes a whole cell down (A4) | L | H | status page; restore drill (M0-26b); one cell per region limits blast radius |
| R5 | Apple/Google reject or delay the app (A7, F13) | M | H | start closed test and external TestFlight early; demo account and review notes |
| R6 | Push gateway outage silences native push for all installs | L | M | socket drain on open is the source of truth (03 R13); degrade to Web Push; two gateway instances |
| R7 | Expo account or OTA channel compromise replaces signing code | L | H | no OTA in production at 2.0.0; 2FA and hardware key on Expo, Apple, Google, npm, Railway |
| R8 | Team policy confusion: a relay withholds policy | L | M | agent fails closed on missing/older policy, alerts the owner |
| R9 | Per-replica limits multiply by R | M | L | limits set at 1/R of the bound; R <= 4 |
| R10 | Cost model (A1) is wrong by 2–3x | M | L | measure in WI-1/3; cost is small in absolute terms; hard limit |
| R11 | Metadata-only promise erodes through a convenience label or log field | M | H | allow-list test (WI-7), review rule: no id-typed label |
| R12 | Apple watch/Android parity expectations vs. owner priorities | M | L | state non-parity in the listing and README |

## 7. Work items

Sizes: S <= 1 h, M <= 2 h, L <= 4 h of Opus 5.5 time (ROADMAP scale).

1. **Four-replica soak on staging** (M, deps: ADR 0016 staging, owner run). Run `pnpm soak`
   with 4 replicas, 3,000 sockets, a forced rolling restart. AC: `docs/verification/
   scale-cell.md` records p99 attach-to-ready < 5 s, p99 cross-replica forward < 200 ms,
   max `pg_notification_queue_usage()` < 0.01, zero lost decisions.
2. **Queue and socket alerts** (S, deps: none). Expose `notify_queue_usage` and
   `sockets_total` in `/metrics`; runbook thresholds. AC: unit test with a stub pool
   asserts both fields; runbook lists alert at 25 % and 50 %.
3. **Cost model script** (S, deps: 1). `scripts/cost-model.mjs` computes the section 4.3
   table from Railway rates and measured RAM/CPU. AC: `node scripts/cost-model.mjs
   --users 1000` prints the replica/Postgres/egress line items and a per-user figure.
4. **Cell config and cell-aware clients** (M, deps: none). `cells.json`; `relayUrl` stored
   per pairing in agent config and native app; signup selects a cell. AC: harness test
   with two relays and two databases: a user paired on cell A never appears on cell B;
   the agent refuses a `relayUrl` not in its pairing record.
5. **Per-account quotas** (M, deps: none). bytes/day, pending/machine, `startSession`/hour,
   push/hour. AC: unit tests per quota returning `rate_limited` and an audit entry; limits
   configurable by env; no payload in logs (grep test).
6. **Team schema migration (additive)** (M, deps: v2 teams decision). `orgs`, `memberships`,
   `machine_grants`, `org_policies`; `audit_log.org_id`. AC: `db:generate` diff clean;
   forward-only migration on a v1 dump keeps every v1 row routable; schema-introspection
   gate (I3) still passes.
7. **Cross-tenant property test and log allow-list** (M, deps: 6). Two-tenant randomised
   workload in `pg-real`; log-key allow-list test over every relay route. AC: 1,000 seeded
   runs find zero cross-tenant rows/frames; any new log key outside the set fails CI.
8. **Router grantee resolution** (L, deps: 6). Hub resolves the grantee set per machine,
   invalidated on grant/revoke across replicas. AC: harness test with 2 replicas: revoke on
   replica A stops delivery to the grantee on replica B within 1 s.
9. **Push gateway** (L, deps: M4-05). `apps/push-gateway` with APNs token auth and FCM;
   relay `PushPort` adapter `gateway`. AC: contract test with a fake APNs/FCM server;
   payload contains only metadata + `pushBlob` (existing privacy gate passes); a relay with an
   unregistered key gets 401; per-relay rate limit returns 429.
10. **Self-host kit** (M, deps: 9). `deploy/selfhost/compose.yml`, `.env.example`, doc.
    AC: a CI job runs `docker compose up` and a harness pairing + approval completes against
    it; `.env.example` contains no secret values.
11. **Android build, FCM and Play closed test** (L, deps: M4-03, 9). AC: signed AAB in the
    Play internal track; a high-priority FCM data message wakes the app in Doze on a real
    device and an action-button Deny reaches the agent (logged in `docs/verification/
    android.md`); closed test with 12 testers started (date recorded).
12. **Mobile release workflow and version gate** (M, deps: M4-08). `mobile-release.yml`
    on `app-v*`; `appVersion` in `hello`, `MIN_APP_VERSION`, `upgrade_required`. AC: dry
    run builds both platforms via EAS; harness test: an old `appVersion` receives
    `upgrade_required` and the socket closes with a defined code.
13. **Hourly counter table and weekly summary** (M, deps: 2). `ops_counters`; aggregate
    only. AC: schema has no column that can hold a user/device id (introspection test);
    a script prints the last 7 days; rows older than 90 days are pruned.
14. **Opt-in client telemetry with scrubbing** (S, deps: native app). AC: with telemetry off
    no network call to Sentry is made (test); with it on, a synthetic error containing a
    pairing code arrives with the code redacted.
15. **Watch notification actions spike** (S, deps: M4-05). Verify on a real watch that the
    Deny action works from the mirrored notification and Allow is absent. AC: logged in
    `docs/verification/native-app.md`.

## 8. Open questions for the owner

1. **Cells vs. one cell.** Plan for cells from the start (section 4.2) or ship one cell and
   retrofit? Default: one cell now, but WI-4 (per-pairing `relayUrl`) lands before the first
   TestFlight build so clients never hardcode a host.
2. **Which region(s)?** Default: EU only until a user asks for the US.
3. **Licence for the relay and gateway** (MIT, AGPL, source-available). Default: keep the
   current licence; revisit before announcing self-host.
4. **Open signup?** Default: invite-only, 3 invites per user, until a moderation story exists.
5. **OTA updates.** Default: off in production for 2.0.0.
6. **Watch Allow.** Default: Deny-only (section 4.7), until a risk-scoring policy exists.
7. **Push gateway trust.** Default: hosted by the publisher, source published, URL override
   supported.
8. **Google Play account type.** Personal (12x14 test, F13) or organisation. Default:
   personal, start the closed test as soon as Android builds.
9. **Hosted pricing.** Cost is ~$0.02 per user per month (section 4.3); the question is
   free-with-caps, donation, or paid. Default: free with caps for the named circle; no
   in-app purchase flow (App Store rules around accounts and payments were not verified).

## 9. Sources

- https://docs.railway.com/pricing/plans (F1, F2, 2026-10-24)
- https://docs.railway.com/reference/scaling (F3)
- https://docs.railway.com/deployments/regions (F4)
- https://docs.railway.com/reference/private-networking (F5)
- https://docs.railway.com/reference/usage-limits (F6)
- https://docs.railway.com/networking/public-networking/specs-and-limits ,
  https://docs.railway.com/reference/metrics , https://docs.railway.com/reference/logging (F7)
- https://www.postgresql.org/docs/current/sql-notify.html (F8)
- https://recall.ai/blog/postgres-listen-notify-does-not-scale ,
  https://dbos.dev/blog/postgres-listen-notify-scalability ,
  https://hackorum.dev/topics/51945 (F9, search snippets, not fetched in full)
- https://developer.apple.com/programs/whats-included/ (F10)
- https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview (F11)
- https://support.google.com/googleplay/android-developer/answer/6112435 (F12)
- https://support.google.com/googleplay/android-developer/answer/14151465 (F13)
- https://firebase.google.com/docs/cloud-messaging/customize-messages/setting-message-priority (F14)
- https://expo.dev/pricing (F15)
- Local: `docs/analysis/reports/03-backend.md`, `06-platform.md`, `docs/analysis/ROADMAP.md`
  (D4, D15–D17), `docs/adr/0011`, `0012`, `0016`, `0017`.
- Fetched but not usable as a source (404 or title only): Railway cost-control page, Expo EAS
  pricing docs page, Apple APNs and watchOS documentation pages (their facts are assumptions A2,
  A6).
