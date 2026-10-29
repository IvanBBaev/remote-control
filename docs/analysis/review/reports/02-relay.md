# 02 — Backend / relay review (AREA: RLY)

As-built review of `apps/relay` at `main @ f0281ef`. Reviewer role 02, Backend / relay engineer.

## 1. Summary

The relay is in good shape for its size. It has 31 test files. It has an origin guard and a
`__Host-` session cookie. Rate limits exist for every HTTP route group. Migrations are
serialised under an advisory lock, and the drain path is explicit (1012, then exit within
25 s). Logs and Sentry events are scrubbed. No plaintext crosses the relay. The defects that
remain are deploy-time and real-device problems, not design flaws:

- **F1 (high):** every production deploy runs two processes with separate in-memory hubs for
  up to about 45 s. The cross-process hub (`RC_HUB=pg`, ADR 0012/0016) is already built but is
  not the production default.
- **F2 (medium):** if a device's APNs environment does not match its token, the relay deletes
  the token silently. Nothing reports why.

**Verdict:**
- M1 release: **ready-with-fixes** (F1, F3 and F6 are each S/M).
- Native TestFlight (M4-08): **ready-with-fixes**. F2 must be fixed before device testing,
  and M4-05 (still partial) must close.

## 2. Verified facts

- **Deploy topology.**
  - `railway.json:9` runs `preDeployCommand node dist/migrate.js`.
  - `railway.json:14-16` sets `numReplicas 1`, `overlapSeconds 20` and `drainingSeconds 30`.
  - Staging overrides `numReplicas 2` (`railway.json:19-21`).
- **Hub default.** `apps/relay/src/config.ts:255` has `hub: e.RC_HUB ?? 'local'`.
  `docs/adr/0012-pg-notify-hub.md:75-76` says "the default stays `local`". ADR 0016 (`:35-36`)
  pairs `local` with the in-process `MemoryChallengeLedger`.
- **Migrations.**
  - `apps/relay/src/db/migrator.ts` uses `pg_advisory_lock(7_263_000_008)` with
    `lock_timeout`, then `verifyMigrationHistory`, then `applyPending`.
  - `migrator.pg-real.test.ts:62` proves that two concurrent runners serialise.
  - Migrations 0000–0004 exist. `0004_push_kind.sql` relaxes NOT NULL on `p256dh`/`auth` and
    adds `kind`, `apns_environment` and a CHECK constraint.
  - No document or check requires expand/contract compatibility: `grep -rni "expand\|backward.compat" docs/` finds no migration rule.
- **Drain.**
  - `apps/relay/src/core/relay-router.ts:130-139`: `drain()` sets `#draining`, calls
    `shutdown()` on every session (close 1012), clears the ack tracker and runs `markSeen`.
  - `#announce` is a no-op while draining (`:183`).
  - `shutdown.ts` forces exit after 25 s.
  - `app.test.ts:82` covers `/health` returning 503 while draining.
- **Shutdown order.** `DeviceSession.closed()` (`relay-router.ts:400-411`) calls `hub.detach`
  before it checks `#draining`. Under PgNotifyHub that publishes one `off` per device before
  `bye`.
- **Undelivered commands.** `relay-router.ts:243-266`: when the target device is offline and
  belongs to the same user, the router calls `pending.undelivered(...)` and returns. No frame
  goes back to the sender. `push-notifier.ts:71` ignores anything that is not a request, so an
  offline `cls: command` frame is dropped without a trace.
- **Push limiter.**
  - `push-notifier.ts:25` sets `perRequest` to 1 per 5 min.
  - `:110` consumes `rid:<envelopeId>` before the subscription lookup and before the send.
  - Results are logged at `:167` (sent), `:170` (gone, deleted) and `:173` (failed, status only).
- **APNs sender.**
  - `apps/relay/src/adapters/apns-sender.ts:49` defines
    `GONE_REASONS = {BadDeviceToken, DeviceTokenNotForTopic, Unregistered}`. Lines `:179-182`
    map a 410, or a 400 with one of those reasons, to `{kind:'gone'}`.
  - `ports/push.ts:21-26`: `PushResult` has no field for the reason, so the reason is dropped.
  - There is no retry for 429/5xx.
  - `ApnsSenderOptions` (`:23-30`) has no logger.
  - `close()` exists, but `main.ts` onClose (cluster stop, push idle, audit idle, errors flush,
    db close) never calls it.
- **Client-chosen APNs environment.**
  - `apps/mobile/src/state/push.ts:38` sends `environment: apnsEnvironment(__DEV__)`.
  - `apps/mobile/src/core/notifications.ts:188` maps that to sandbox or production.
  - `apps/mobile/ios/remotecontrol/remotecontrol.entitlements:5-6` sets
    `aps-environment=development`.
  - The relay trusts the client value (`http/push-routes.ts:44-49`).
  - `apns-sender.test.ts:187-191` asserts BadDeviceToken → `gone`. No test covers an
    environment mismatch.
- **Push config.**
  - `apps/relay/src/container.ts:154` logs `push_disabled` at info level when `RC_VAPID_*` is
    missing.
  - `config.ts` does not require VAPID or APNs credentials when `NODE_ENV=production`.
- **Sentry coverage.**
  - Capture calls exist only at `app.ts:146` (HTTP 5xx), `crash-handlers.ts:40` and
    `admin-command.ts:158`.
  - `route_failed`, `gate_failed` and `presence_failed` in `relay-router.ts` go to
    `logger.error` only.
  - `push failed` is a `logger.warn` (`push-notifier.ts:173`).
- **PgNotifyHub.**
  - `core/pg-notify-hub.ts`: heartbeat 5 s, replica timeout 15 s, NOTIFY cap 7900 B,
    chunks of 7000 B, at most 64 partial frames.
  - `start()` registers `onReconnect(#resync)`, which forgets remote devices and re-announces.
  - The remote-device proxy's `send` always returns `true`, so backpressure is invisible
    across replicas.
  - Chunk reassembly does not check that `i < n`. The input comes from a trusted DB.
- **PgNotifyBus.** `adapters/pg-notify-bus.ts` reconnects LISTEN after 1 s, forever, and runs
  each publish in its own transaction. On error the publisher is reset.
- **Auth.**
  - Cookie: `core/session-cookie.ts` sets `__Host-rc_session; Path=/; Secure; HttpOnly; SameSite=Strict`.
  - Origin guard: `Origin` must equal the relay origin and `X-RC-Client: pwa` is required.
    A request with a Bearer token and no cookie bypasses the guard.
  - The native app sets `origin` and `cookie` itself (`apps/mobile/src/adapters/relay-transport.ts:17-19`).
  - Limits in `http/auth-routes.ts`: 60/min per IP for any route, 5/h for register,
    20/h per IP and per user for login, 5/h for recovery.
  - `MemoryChallengeLedger` holds 10k entries and answers `busy` (503) when full.
- **WS upgrade.** `ws/ws-route.ts` authenticates in preValidation. The device-cap check and
  the attach are separate steps (`:96-102`). Failed bearer upgrades are not rate limited.
- **Request id.** `app.ts` trusts `requestIdHeader: 'x-railway-request-id'` as sent.
  `http/state-route.ts` has no rate limit.
- **Tests.** `find apps/relay -name '*.test.ts' | wc -l` → 31. They include `shutdown.test`,
  `pg-notify-hub.test`, `pg-notify-bus.pg-real.test`, `migrator.pg-real.test`, `ws-route.test`
  and `apns-sender.test`. No test covers two processes with `RC_HUB=local` (the deploy overlap)
  or the APNs environment mismatch: `grep -rn overlap apps/relay/src` finds only a comment and
  the migrator test.

## 3. Assumptions

- **Railway overlap.** I assume Railway keeps the old deployment serving for `overlapSeconds`
  after the new one passes `/health`, then sends SIGTERM and allows `drainingSeconds`. This is
  Railway's documented behaviour; I did not observe a live deploy (M0-02b is `blocked-owner`).
- **Phone re-send.** I assume the phone's outbox re-sends a pending command when presence turns
  online (D4). I did not trace phone-core end to end; role 03/06 owns that.
- **APNs reason.** I assume Apple returns `400 BadDeviceToken` when a development token is sent
  to the production gateway (and the reverse). This is Apple's documented behaviour.
- **No test run.** I did not run vitest: `node` is not on PATH in this shell (the servicenow MCP
  server also failed with `ENOENT node`). All facts are from reading the code.

## 4. Findings

### F1 — high — Every deploy runs two processes with separate in-memory hubs

**Evidence:** `railway.json:14-16` (overlap 20 s, draining 30 s) together with
`config.ts:255` (`RC_HUB` defaults to `local`) and ADR 0016 `:35` (memory challenge ledger
under `local`).

**What happens:** for the overlap window, plus up to 25 s of drain, the old process keeps its
existing sockets and the new process takes every new connection. Each process has its own
LocalHub and its own challenge and verified-decision state.

**Why it matters:**
- A phone that reconnects lands on the new process while the agent stays on the old one, or the
  other way round.
- The phone then sees the agent as offline.
- Requests trigger spurious "agent offline" pushes through `pending.undelivered`.
- Commands are dropped silently (F4).
- A WebAuthn challenge issued by one process fails on the other.
- A step-up `decisionHash` verified on one process is unknown on the other, so `admit` rejects
  the decision (`decision-verifier.ts:128-136`).

This happens on **every** deploy, not just on crashes.

**Not covered elsewhere:** R14 assumes a clean restart (all sockets drop, then reconnect), and
D15 assumes one process.

**Touches:** D15, D16, R14, ADR 0012/0016.

### F1b — medium — Migrations have no backward-compatibility rule

**Evidence:** `railway.json:9`. The pre-deploy migration runs while the old version still
serves for at least 20 s more. D17 runs migrations both pre-deploy and at boot.

**Why it matters:** nothing documents or checks that a migration must be expand-only. Migration
0004 happens to be compatible (it relaxes NOT NULL and adds a column with a default). A future
`DROP`, `RENAME` or `SET NOT NULL` would break the old process during the overlap and would
break any rollback.

**Touches:** D17, M4-05 (schema churn), lane rule "`apps/relay/drizzle/**` regenerated last".

### F2 — medium — An APNs environment mismatch deletes the token silently

**Evidence:**
- The app picks the environment from `__DEV__` (`notifications.ts:188`, `push.ts:38`), but the
  token's real environment comes from the provisioning profile's `aps-environment`
  (`remotecontrol.entitlements:5-6` says `development`).
- So a Release-configuration build signed with a development profile, which is common for
  device testing before TestFlight, registers a sandbox token as `production`.
- APNs then answers `400 BadDeviceToken`. `apns-sender.ts:181` maps that to `gone`, and
  `push-notifier.ts:170` deletes the subscription.
- The log line contains no reason, because `PushResult` has no reason field (`ports/push.ts:21-26`).

**Why it matters:**
- On the first real device run (M4-08 AC 2) notifications stop after one attempt.
- Nothing shows the cause.
- The app re-registers the same wrong environment on its next launch, so the problem repeats.

**Touches:** M4-05, M4-08, Q22. The `push-gateway` lane (V3-C02) is affected because the port
signature must not change.

### F3 — medium — WebSocket and push failures never reach Sentry

**Evidence:**
- Capture exists only at `app.ts:146`, `crash-handlers.ts:40` and `admin-command.ts:158`.
- `route_failed`, `gate_failed` and `presence_failed` (`relay-router.ts`) are `logger.error`
  only.
- Push failures are `logger.warn` (`push-notifier.ts:173`).

**Why it matters:** the product runs on the WebSocket and push paths. HTTP 5xx is the least
interesting signal. M0-26b wires up the Sentry DSN, but there is nothing on these paths for it
to report.

**Touches:** M0-26b, D19 (any capture must go through the existing scrubber).

### F4 — low — A command sent to an offline device gets no feedback

**Evidence:**
- `relay-router.ts:243-266` drops the frame into `pending.undelivered` and returns.
- `push-notifier.ts:71` ignores anything that is not a request.
- No error or nack frame is sent back.

**Why it matters:** with D4 (no outbox) the phone depends on re-sending after presence turns
online. Combined with F1 this is a silent loss window on every deploy. Severity is low only
because D4 makes the re-send the documented contract.

**Touches:** D4, R14.

### F5 — medium — A transient push failure burns the request's only push

**Evidence:**
- `push-notifier.ts:110` consumes the per-request budget (1 per 5 min) before the send.
- `apns-sender.ts` does not retry on 429, 5xx or timeout.
- `web-push-sender` behaves the same way.

**Why it matters:** one APNs 503 or network blip means the approval notification never arrives
for that request, even if the request waits 10 minutes. This is the core use case (M0-23b:
"held ≥ 11 min").

**Touches:** D5, M4-05.

### F6 — medium — A production deploy without push credentials starts silently

**Evidence:**
- `container.ts:154` logs `push_disabled` at **info** level.
- `config.ts` does not require `RC_VAPID_*` or `RC_APNS_*` when `NODE_ENV=production`.

**Why it matters:** a missing secret on Railway (M0-02b) produces a healthy relay that never
notifies anyone. `/health` stays green.

**Touches:** M0-02b, M0-26b.

### F7 — low — WebSocket upgrade abuse and the device-cap race

**Evidence:**
- Failed bearer upgrades in `ws-route.ts` are not rate limited, so each failure is a DB lookup.
- The device-cap check and the attach are separate steps (`:96-102`), so two concurrent
  upgrades can exceed the cap by one.

**Why it matters:** a cheap DB-load vector. The cap overshoot is cosmetic.

**Touches:** D15 limits.

### F8 — low — Shutdown has loose ends

**Evidence:**
- `DeviceSession.closed()` calls `hub.detach` before the draining check, so with PgNotifyHub
  every device publishes `off` before `bye`. Peers see an offline flicker on every deploy.
- `apns-sender.close()` is never called, so the HTTP/2 session is left for the force-exit.
- `README.md:210` says "/health turns 503 on SIGTERM", but `app.close()` stops listening, so
  Railway mostly sees connection refused.

**Touches:** D15.

### F9 — low — Hygiene

- `x-railway-request-id` is trusted as the log correlation id, so a client can choose it.
- `/api/state` has no rate limit.
- PgNotifyHub chunk reassembly does not bound `i < n`.

### F10 — low — Invariant numbering differs between documents

**Evidence:**
- ROADMAP §1: I1 = "nothing runs because the relay said so", I2 = the agent never hangs,
  I3 = metadata only, I4 = npx with no auto-update.
- `docs/analysis/review/00-state.md` and the project `CLAUDE.md`: I1 = no plaintext,
  I2 = no payload stored, I3 = no authority, I4 = the agent never grants.

**Why it matters:** reviewers and ADRs cite I-numbers that mean different things.

**Touches:** documentation only.

## 5. Recommendations

1. **F1:** set `RC_HUB=pg` in production too, keeping one replica.
   - Why: PgNotifyHub and the Postgres ChallengeLedger already exist and are staging-tested
     (ADR 0016). With the pg hub, the old and new processes share presence, routing, challenges
     and verified decisions during the overlap. The cost is one DB round trip per command that
     carries a decision (ADR 0016 `:116`), which is acceptable.
   - Change the default in `config.ts` to `pg` when a DB URL is set and `NODE_ENV=production`,
     or pin it in the Railway variables and assert it at boot.
   - Add an ADR note amending ADR 0012 `:75`.
   - *Rejected:* `overlapSeconds: 0`. That gives a hard cut, a reconnect storm and a window with
     no healthy instance.
   - *Rejected:* keeping `local` and documenting it as R14. Spurious offline pushes on every
     deploy erode trust in notifications.
2. **F1b:** add an expand/contract rule to `apps/relay/drizzle/README` or the
   `db/migrator.ts` doc, plus a CI grep that fails on `DROP COLUMN|RENAME|SET NOT NULL` in new
   migrations unless the migration carries an explicit `-- contract:` marker.
   - *Rejected:* migrating only at boot (dropping pre-deploy). The old process would still
     overlap the change.
3. **F2:**
   - (a) Log the APNs `reason` inside the sender through an optional `onRejected(reason)` hook
     in `ApnsSenderOptions`. This leaves `ports/push.ts` unchanged, as the push-gateway lane
     requires.
   - (b) On `BadDeviceToken`, retry once against the other environment. If that succeeds,
     update the stored `apns_environment` instead of deleting the subscription.
   - (c) The app should derive the environment from the entitlement, not from `__DEV__`. That is
     out of scope for RLY; I flag it for role 05 and do not size it here.
   - *Rejected:* trusting only the app. The relay must not delete a working token on a
     client-side bug.
4. **F3:** add `errors.capture` (already scrubbed, 20/min) to the three router error sites and
   to `push failed` when the status is 5xx or null. Keep `event` names on the allow-list.
5. **F5:** consume the `rid` budget only after a `sent`/`gone` result. On `failed` with
   429/5xx/null, retry once after 2–5 s.
   - *Rejected:* a durable retry queue. It contradicts D4 and I2.
6. **F6:** when `NODE_ENV=production` and no push transport is configured, log `push_disabled`
   at warn level and report `push: 'off'` in `/health` (still 200). Fail-closed is optional
   behind `RC_REQUIRE_PUSH=1`.
7. **F4:** send an `undeliverable` control frame (metadata only) for `cls: command`. This sits
   in `apps/relay/src/core`, not the ws lane, but it needs a protocol addition, so it is
   deferred until the version gate (V3-C12) lands.

## 6. Risks (new)

| ID | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| RN-RLY-1 (extends R14) | Every deploy splits presence and state between two processes for ≤45 s: spurious pushes, rejected step-ups, silent command loss | High / medium | RV-RLY-01 |
| RN-RLY-2 | A destructive migration breaks the still-serving old process or a rollback | Medium / high | RV-RLY-02 |
| RN-RLY-3 | An APNs environment mismatch silently unsubscribes test devices; M4-08 is misdiagnosed as an app bug | High during M4-08 / medium | RV-RLY-03 |
| RN-RLY-4 | A misconfigured push secret ships a "healthy" relay that never notifies | Medium / high | RV-RLY-06 |

## 7. Work items

| ID | Title | Size | Deps | Files touched | Acceptance criteria | Finding |
|---|---|---|---|---|---|---|
| RV-RLY-01 | Production uses the pg hub; two-process overlap test | M | M0-02b (deploy), ADR 0016 | `apps/relay/src/config.ts`, `apps/relay/src/config.test.ts`, `apps/relay/src/core/pg-notify-hub.test.ts` (or a new `overlap.pg-real.test.ts`), `docs/adr/0012-pg-notify-hub.md` (amend note) | `config.test.ts` case "production with a database URL selects the pg hub" passes. New test "phone on process A, agent on process B: request routed, no undelivered push" passes under `pnpm --filter @remote-control/relay exec vitest run overlap`. `grep -n "default stays \`local\`" docs/adr/0012-pg-notify-hub.md` → 0 hits | F1 |
| RV-RLY-02 | Expand/contract migration rule and CI guard | S | — | `apps/relay/drizzle/**` [lane rule: regenerated last; doc only, no SQL change], `scripts/check-migrations.mjs` (new), root `package.json` check script | `pnpm check` runs the guard. A fixture migration containing `DROP COLUMN` without `-- contract:` makes the guard exit 1. `grep -rn "expand/contract" apps/relay` ≥ 1 hit | F1b |
| RV-RLY-03 | APNs: log the rejection reason, retry the other environment on BadDeviceToken, keep the token if that succeeds | M | M4-05 | `apps/relay/src/adapters/apns-sender.ts` [push-gateway lane: adapter only, `ports/push.ts` unchanged], `apps/relay/src/adapters/apns-sender.test.ts`, `apps/relay/src/core/push-notifier.ts`, `apps/relay/src/core/push-store*.ts` | Test "sandbox token registered as production is retried on sandbox and the stored environment is updated" passes. Test "BadDeviceToken on both environments → gone with reason logged" passes. `git diff main -- apps/relay/src/ports/push.ts` is empty | F2 |
| RV-RLY-04 | Send WebSocket-path and push failures to Sentry | S | M0-26b (DSN) | `apps/relay/src/core/relay-router.ts`, `apps/relay/src/core/push-notifier.ts`, their tests | Test "route_failed calls errors.capture once with a scrubbed message" passes. Test "push failed with status 503 is captured; 400 is not" passes | F3 |
| RV-RLY-05 | Push: spend the per-request budget only on a final result; one bounded retry | S | RV-RLY-03 | `apps/relay/src/core/push-notifier.ts`, `push-core.test.ts` | Test "a failed 503 send retries once and the rid budget stays unspent until sent" passes. Test "two retries never happen for one rid" passes | F5 |
| RV-RLY-06 | Production push-config visibility | S | — | `apps/relay/src/container.ts`, `apps/relay/src/app.ts` (`/health` field), tests | Test "production without VAPID/APNs logs push_disabled at warn" passes. `/health` JSON contains `"push":"off"` in that case (app.test). Test "RC_REQUIRE_PUSH=1 without credentials fails config parse" passes | F6 |
| RV-RLY-07 | Shutdown hygiene: no `off` while draining, close the APNs sender, fix the README 503 claim | S | — | `apps/relay/src/core/relay-router.ts`, `apps/relay/src/main.ts`, `apps/relay/README.md` | Test "drain under PgNotifyHub publishes bye and no per-device off" passes. `main.test` asserts that `apns.close` is called on close. `grep -n "turns 503" apps/relay/README.md` → 0 hits or a reworded line | F8 |
| RV-RLY-08 | Rate-limit failed WebSocket upgrades per IP; make the device-cap check atomic | S | V3-C12 (lane owner of `ws/**`) | `apps/relay/src/ws/ws-route.ts` [version-gate lane], `ws-route.test.ts` [version-gate lane] | Test "the 31st failed bearer upgrade per minute from one IP gets 429 without a DB lookup" passes. Test "two concurrent upgrades at cap-1 admit exactly one" passes | F7 |
| RV-RLY-09 | Hygiene: generated request ids, `/api/state` limit, chunk bounds | S | — | `apps/relay/src/app.ts`, `apps/relay/src/http/state-route.ts`, `apps/relay/src/core/pg-notify-hub.ts`, tests | `grep -n "requestIdHeader: 'x-railway-request-id'" apps/relay/src/app.ts` → 0 hits (the Railway id is logged as a separate field). Test "/api/state answers 429 past its limit" passes. Test "chunk with i ≥ n is dropped" passes | F9 |
| RV-RLY-10 | Unify the invariant numbering | S | — | `docs/analysis/review/00-state.md` or `docs/analysis/ROADMAP.md` §1 (one source, the other cites it) | `grep -n "I1" docs/analysis/review/00-state.md` matches the ROADMAP §1 wording | F10 |

F4 is deliberately not given a work item: it needs a protocol change. It is recommended to
follow V3-C12.

## 8. Open questions for the owner

1. **Production hub.** Run production on `RC_HUB=pg` with one replica?
   *Default: yes (RV-RLY-01).*
2. **Fail-closed push.** Should a production relay refuse to boot without push credentials, or
   only warn? *Default: warn plus a `/health` field; fail-closed only with `RC_REQUIRE_PUSH=1`.*
3. **APNs fallback.** On BadDeviceToken, may the relay retry the other APNs environment and
   rewrite the stored one? *Default: yes, once per subscription.*
4. **Undeliverable frame.** Add an `undeliverable` frame for offline commands (protocol change)?
   *Default: no for M1; revisit after V3-C12.*

## 9. Sources

- **Relay code:**
  - `railway.json`
  - `apps/relay/src/config.ts`, `container.ts`, `main.ts`, `app.ts`, `shutdown.ts`, `crash-handlers.ts`, `admin-command.ts`
  - `apps/relay/src/core/relay-router.ts`, `pg-notify-hub.ts`, `push-notifier.ts`, `decision-verifier.ts`, `memory-challenge-ledger.ts`, `session-cookie.ts`, `origin-guard.ts`, `scrub-message.ts`
  - `apps/relay/src/adapters/apns-sender.ts`, `pg-notify-bus.ts`, `sentry-reporter.ts`
  - `apps/relay/src/http/auth-routes.ts`, `push-routes.ts`, `admin-routes.ts`, `state-route.ts`, `origin-guard-hook.ts`
  - `apps/relay/src/ws/ws-route.ts`, `apps/relay/src/ports/push.ts`, `apps/relay/src/db/migrator.ts`
  - `apps/relay/drizzle/0000–0004`
- **Tests:** the 31 `*.test.ts` files under `apps/relay/src`.
- **Mobile:**
  - `apps/mobile/src/core/notifications.ts`, `apps/mobile/src/state/push.ts`, `apps/mobile/src/adapters/relay-transport.ts`
  - `apps/mobile/ios/remotecontrol/remotecontrol.entitlements`
- **Docs:**
  - `docs/analysis/ROADMAP.md` §1, §2 (D4, D5, D15–D17, D19), §4 (M0-02b, M0-23b, M0-26b, M4-05, M4-08), §7 (R14)
  - `docs/adr/0012-pg-notify-hub.md`, `docs/adr/0016-staging-and-shared-challenges.md`
  - `docs/analysis/v3/ROADMAP-v3.md` and `PARALLEL.md` (V3-C01/C02/C12/C13/C16, lanes)
  - `docs/analysis/review/00-state.md`
