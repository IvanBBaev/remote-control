# Operations runbook

The relay runs on Railway (Hobby): one `relay` service built from the root `Dockerfile`
and one Postgres 17 service. Nobody watches it day to day, so this runbook covers what
to do when an alert arrives and the few routine tasks (06 W10, W12, W20; D16, D19).

Commands assume the [Railway CLI](https://docs.railway.com/guides/cli) linked to the
project (`railway link`) and run from the repository root.

## Signals

| Signal                       | Source                                 | Meaning                                                                                                            | First step                                                                                 |
| ---------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| "Monitor is DOWN" e-mail     | UptimeRobot, `GET /health` every 5 min | `/health` is not `200`: the relay is down, crash-looping, or `SELECT 1` fails (503 `"degraded"`)                   | [Relay down](#relay-down)                                                                  |
| Sentry e-mail "new issue"    | Sentry (relay only)                    | A 5xx from a handler (`event:http_error`) or a crash (`uncaught_exception` / `unhandled_rejection`, level `fatal`) | Open the issue; tags `route`, `method`, `req_id`; search the Railway logs for the `req_id` |
| Railway "usage alert" e-mail | Railway, at $8                         | Usage this month passed the soft alert                                                                             | [Cost check](#cost-check)                                                                  |
| Railway "hard limit" e-mail  | Railway, at $15                        | Services are **stopped** until the limit is raised or the month rolls over                                         | [Cost check](#cost-check), then raise the limit if the growth is real                      |
| Railway deploy failed e-mail | Railway                                | Build, pre-deploy migration or healthcheck failed; the previous deployment keeps serving                           | [Deploy](#deploy)                                                                          |

Error reports carry metadata only: exception type, a scrubbed message (URLs, e-mail
addresses, quoted strings and token-like runs replaced), stack frames, and the tags
`event`, `route`, `method`, `req_id`. There are no request bodies, headers, users or
breadcrumbs (the relay does not use the Sentry SDK — see the relay README). At most
20 reports per minute are sent; drops are logged as `sentry_rate_limited`.

## CI and branch protection

| Workflow  | Jobs                                     | Runs on                                 | Checks                                                                                                                                                                                                            |
| --------- | ---------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CI`      | `ci`                                     | every PR, push to `main`                | `pnpm audit --prod --audit-level=high`, `pnpm audit signatures`, `pnpm check` (coverage thresholds per D18 + `tools/coverage-policy.test.ts`, journeys)                                                           |
| `CI`      | `image`                                  | every PR, push to `main`                | `docker build` of the relay image, Trivy scan (fixable HIGH/CRITICAL fail)                                                                                                                                        |
| `CI`      | `agent-os (ubuntu/macos/windows-latest)` | every PR, push to `main`                | agent + fake Claude Code suites, journeys J1/J2/J5; `agent-os` passes only when all three do                                                                                                                      |
| `pg-real` | `pg-real`                                | push to `main`, nightly, manual         | relay suites against a real Postgres 17 service                                                                                                                                                                   |
| `e2e`     | `browser-crypto`, `playwright`           | push to `main`, nightly, PR label `e2e` | crypto known-answer vectors in Chromium and WebKit (`pnpm test:browser`); Playwright journeys P1–P9 (Chromium) and WebKit smoke W1–W2 (`pnpm test:e2e`), HTML report uploaded as the `playwright-report` artifact |

Dependabot opens grouped weekly PRs for npm, GitHub Actions and the Docker base image;
they go through the same checks, and pnpm's 7-day `minimumReleaseAge` still applies.

Branch protection on `main` (Settings → Branches, or the API) requires these status
checks, up to date before merging:

- `ci`
- `agent-os`
- `image`

```sh
gh api -X PUT repos/IvanBBaev/remote-control/branches/main/protection \
  -F 'required_status_checks[strict]=true' \
  -f 'required_status_checks[contexts][]=ci' \
  -f 'required_status_checks[contexts][]=agent-os' \
  -f 'required_status_checks[contexts][]=image' \
  -F enforce_admins=false -F required_pull_request_reviews=null -F restrictions=null
```

A red `pg-real` or `e2e` on `main` does not block merges; fix it before the next deploy.
Coverage thresholds live in `vitest.config.ts`; lowering one below its D18 floor, adding
a package without a threshold, or adding a `v8`/`c8`/`istanbul` ignore pragma fails `ci`.

## Deploy

Pushes to `main` deploy automatically once CI is green. A deployment builds the image,
runs `node dist/migrate.js` (pre-deploy), starts the new container, waits for
`/health` = 200 (timeout 100 s), overlaps the old one for 20 s, then drains it (SIGTERM →
`/health` 503, sockets closed with 1012, exit within 25 s).

1. Watch it: `railway logs --deployment` or the dashboard's deployment view.
2. Check: `curl -s https://<relay-domain>/health` shows the new `commit`.
3. A failed migration or healthcheck leaves the previous deployment serving; fix
   forward on `main`.

## Rollback

1. Dashboard → `relay` → Deployments → the last good deployment → **Redeploy**
   (or `git revert` the bad commit and push, which also keeps `main` honest).
2. Migrations are forward-only (M0-03). A rollback across a migration works only when
   the migration was additive; otherwise restore the database from the backup taken
   before the deploy ([Backup and restore](#backup-and-restore)).
3. Check `/health` and `/api/version` show the old `commit`.

## Relay down

1. `curl -si https://<relay-domain>/health` — `503 "degraded"` means the database is
   unreachable (check the Postgres service), `503 "draining"` that a deploy is under
   way, no answer that the service is stopped or crash-looping.
2. `railway logs` — look for `"level":"fatal"` (`uncaught_exception`,
   `unhandled_rejection`; these also appear in Sentry) or a plain startup line naming
   an invalid variable (values are never echoed).
3. Fix a configuration error under `relay` → Variables, which redeploys.
4. Railway restarts a crashed process up to 10 times (`ON_FAILURE`); after that,
   redeploy from the dashboard once the cause is fixed.
5. Check the usage limit: a reached hard limit stops every service.

## Backup and restore

Railway backups on the Postgres volume: daily (kept 6 days), weekly (27 days),
monthly (89 days) plus manual ones; incremental, billed like volume storage, restorable
only into the same project and environment (dashboard → Postgres → Backups). If backups turn out to be unavailable on
the plan (06 A3), a `pg_dump` cron service becomes mandatory (06 W10).

What a restore loses: everything written since the backup. Phones and agents keep
working with the accounts and pairings that existed then; anything newer has to be
paired again. The relay stores no message payloads, so no approvals are lost beyond
the ones in flight.

Restore:

1. Dashboard → Postgres → Backups → pick the backup → **Restore**. Railway restores
   into the volume and redeploys Postgres; the relay's `/health` reports
   `"degraded"` until it is back.
2. Check `/health` = `200`, then sign in from the phone and check the agent list.
3. If the relay's code is newer than the backup's schema, the next deploy's
   `migrate.js` brings it forward; trigger one with **Redeploy** on `relay`.

### Restore drill

Run once after setup and after any change to the backup schedule: take a manual
backup, write a marker row, restore the backup, and check the marker is gone and the
relay is healthy. Restoring production rolls back everything since the backup, so drill
right after the manual backup, or in a temporary environment (06 §5.1).

```sh
railway connect Postgres     # psql into the database
# create table restore_drill(at timestamptz default now()); insert into restore_drill default values;
# Dashboard: restore the manual backup taken before the insert.
railway connect Postgres     # \dt restore_drill → "Did not find any relation"
curl -s https://<relay-domain>/health
```

| Date          | Backup restored | Marker gone | `/health` after | Duration | By  |
| ------------- | --------------- | ----------- | --------------- | -------- | --- |
| _not run yet_ |                 |             |                 |          |     |

## Error reporting drill

Proves that a crash reaches Sentry and that the report carries no payload (M0-26 AC):

```sh
railway run node dist/admin.js sentry-test
```

It sends one error (`event:sentry_test`, cause `TypeError: forced crash`) whose message
contains the planted canary `payload=Q0FOQVJZ…`. In Sentry, the issue must show the
message as `remote-control sentry test ([redacted])` and no request, user or extra data.
Exit 1 means `RC_SENTRY_DSN` is unset or the send timed out.

| Date          | Issue link | Canary absent | By  |
| ------------- | ---------- | ------------- | --- |
| _not run yet_ |            |               |     |

## Rotating secrets

| Secret                                                 | Where                                                    | How                                                                                                         | Effect                                                                                                                                                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| VAPID key pair (`RC_VAPID_PUBLIC`, `RC_VAPID_PRIVATE`) | `relay` → Variables                                      | `node dist/admin.js vapid-keys`, set both, redeploy                                                         | Every push subscription becomes invalid (push services reject the new key). Phones resubscribe the next time the PWA opens; until then pending requests are not pushed. Rotate only on suspected leak. |
| Agent bearer token                                     | Agent machine (`remotectl` config) and relay (hash only) | The agent calls `POST /api/agents/token` with its current token and stores the new one (client side: M0-16) | The old token stops working at once. A leaked token whose agent machine is gone cannot be revoked from the PWA yet (device revocation is a later work package); remove the agent's device row by hand. |
| Sentry DSN (`RC_SENTRY_DSN`)                           | `relay` → Variables                                      | Sentry → Project → Client Keys → create a key, set it, redeploy, then disable the old key                   | A DSN only allows sending events; a leak means spam, not data loss.                                                                                                                                    |
| Database password                                      | Postgres service                                         | Dashboard → Postgres → Variables → regenerate, then redeploy `relay` (it reads `DATABASE_URL` by reference) | Brief `/health` 503 while the relay restarts.                                                                                                                                                          |

Unset `RC_SENTRY_DSN` disables error reporting; unset VAPID keys disable push. Both
leave the relay running.

## Owner counters

`GET /api/admin/counters` (M1-13) returns users, live devices by kind, devices online
now and pushes per UTC day for the last 7 days — no bodies or identifiers. It exists
only while `RC_ADMIN_TOKEN` is set:

```sh
curl -s -H "Authorization: Bearer $RC_ADMIN_TOKEN" https://<relay-domain>/api/admin/counters
```

Use it with the cost check below: pushes and online devices explain most growth.

## Cost check

Monthly, and on any usage e-mail: dashboard → project → Usage.

- Expected (06 §5.7): ≈ $6–7/month for the owner alone, ≈ $18–25 at 100 users. The
  Hobby fee includes $5 of usage.
- Alert at $8, hard limit at $15 (dashboard → Workspace → Usage → limits). Reaching
  the hard limit stops the services.
- RAM dominates. A relay steadily above ~0.6 GB or Postgres above ~0.4 GB at owner-only
  load points to a leak — compare with the deploy that started it.
- Egress above a few GB/month at owner-only load means something is polling or
  reconnecting in a loop: check `ws_reconnects` in the logs.
- Sentry (5k errors/month), UptimeRobot (50 monitors) and GitHub Actions stay on
  free tiers; a Sentry quota e-mail means an error loop — fix the error, not the quota.
