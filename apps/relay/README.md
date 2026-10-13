# @remote-control/relay

Fastify 5 relay: serves the PWA, the API and (later) the WebSocket hub from one
origin. It sees metadata only (invariants I1–I4). Ports & adapters layout:

| Path                            | Role                                                                 |
| ------------------------------- | -------------------------------------------------------------------- |
| `src/core/`                     | Pure logic (`healthReport`, `DrainState`, `AccountService`).         |
| `src/ports/`                    | Interfaces the core depends on (`Db`, `AccountStore`, `WebAuthn`).   |
| `src/adapters/`                 | Implementations (`pg`, system clock). The only place for `Date.now`. |
| `src/http/`                     | Routes: `/health`, `/api/version`, static PWA + SPA fallback.        |
| `src/config.ts`                 | Zod-validated `RC_*` environment.                                    |
| `src/container.ts`              | Wires adapters from config.                                          |
| `src/app.ts`                    | `buildApp(deps)` — the testable Fastify factory.                     |
| `src/main.ts` / `src/server.ts` | Composition root and process entry.                                  |
| `src/admin.ts`                  | Operator CLI (`dist/admin.js invite`, `vapid-keys`, `sentry-test`).  |
| `src/testing/`                  | Test helpers (software WebAuthn authenticator).                      |

## Endpoints

- `GET /health` — `200 {"status":"ok",...}` while serving; `503 "degraded"` when
  `SELECT 1` fails (2 s timeout); `503 "draining"` once shutdown has started (D15).
  Logged at `warn` only, so Railway's probes stay out of the info log.
- `GET /api/version` — `{ version, commit, protocol: { id, v, minSupported } }`.
- Static PWA from `RC_PUBLIC_DIR` (default `apps/web/dist`): `/assets/*` immutable for a
  year, everything else `no-cache`; an unknown `GET` accepting `text/html` outside
  `/api`, `/ws` and `/health` gets `index.html`; anything else is a JSON 404. A
  missing build is tolerated (JSON 404 only).

## Accounts (`/api/auth/*`, D8)

Passkeys only, invite-gated, no passwords. The routes exist only when a
database is configured. Every response is `Cache-Control: no-store`.

| Route                             | Body                           | Result                                                                  |
| --------------------------------- | ------------------------------ | ----------------------------------------------------------------------- |
| `POST /api/auth/register/options` | `{ inviteCode, displayName? }` | WebAuthn creation options; `403 invalid_invite`                         |
| `POST /api/auth/register/verify`  | `RegistrationResponseJSON`     | session cookie + `{ userId, recoveryCode, backedUp }` (code shown once) |
| `POST /api/auth/login/options`    | `{}`                           | request options with empty `allowCredentials` (conditional UI)          |
| `POST /api/auth/login/verify`     | `AuthenticationResponseJSON`   | session cookie + `{ userId }`; `401` on any verification failure        |
| `POST /api/auth/recovery/options` | `{ recoveryCode }`             | creation options for a new passkey; `403 invalid_code`                  |
| `POST /api/auth/recovery/verify`  | `RegistrationResponseJSON`     | new passkey, rotated recovery code, all older sessions revoked          |
| `GET /api/auth/session`           | —                              | `{ userId }` and a refreshed cookie; `401` + cleared cookie otherwise   |
| `POST /api/auth/logout`           | —                              | `204`, session revoked, cookie cleared                                  |

- Registration: `residentKey: required`, `userVerification: required`, ES256 only,
  `attestation: none`, `rp.id = RC_RP_ID`. Login requires UV too; `clientDataJSON`
  must carry `RC_ORIGIN`. Challenges are single-use and live 5 minutes (in memory, D15).
- Session cookie: `__Host-rc_session=<token>; Max-Age=…; Path=/; Secure; HttpOnly;
SameSite=Strict`. The token is 32 random bytes; only its SHA-256 is stored
  (`sessions.token_hash`). It expires after 7 days idle or 30 days after login,
  whichever comes first; `Max-Age` never outlives the absolute expiry.
- Invite codes (26 Crockford base32 chars, 128 bit) are stored as SHA-256 hashes and are
  single-use. Recovery codes (`LOCATOR-SECRET`) are stored as an scrypt hash
  (N=32768, r=8, p=1) and work once; recovery rotates the code.
- Every state-changing `/api` request must carry `Origin: RC_ORIGIN`,
  `X-RC-Client: pwa` and, when sent, `Sec-Fetch-Site: same-origin`; otherwise `403`.
- Rate limits (in process, fixed window, `429` + `Retry-After`): all auth routes 60/min
  per IP; registration 5/h per IP; login 20/h per IP and 20/h per account; recovery
  5/h per IP and 5/h per account; `/session` and `/logout` 120/min per account.
- `audit_log` rows (event, user id, time only): `register`, `login`, `recovery`,
  `session_revoked`, `invite_created`.

### Minting invite codes

```sh
railway run node dist/admin.js invite                    # one code, valid 7 days
railway run node dist/admin.js invite --count 5 --ttl-days 14
pnpm --filter @remote-control/relay admin invite         # local, needs RC_DATABASE_URL
```

Codes go to stdout once (one per line) and are never logged; the database keeps only
their hashes. `--count` is 1–100, `--ttl-days` 1–90. Exit code 2 on a usage error.

## Web Push (`/api/push/*`, M0-12, D5)

When a `cls: "request"` frame targets a phone with no live socket, or the phone has not
acked it after 3 s, the relay sends a Web Push to every subscription of that phone. The
payload is metadata only — `{"t":"pending","rid":"<envelope id>","dev":"<agent name>","exp":<ms|null>}`,
always under 200 bytes — encrypted with aes128gcm and signed with VAPID. Headers:
`Topic` = the envelope id without hyphens (a re-push replaces the pending one),
`Urgency: high`, `TTL` = the request's remaining lifetime (at most 1 h; expired requests
are not pushed). Each request is pushed at most once; each phone gets at most 20 pushes
per minute. A `404`/`410` from the push service deletes the subscription; other failures
set `last_failure_at`. Sending never blocks routing, and failures are logged without
endpoints or keys (D19).

All routes need the session cookie of a phone (`403 {"error":"no_phone"}` otherwise),
are limited to 30 calls/min per account, and state changes pass the origin guard:

| Route                           | Body                        | Response                                                        |
| ------------------------------- | --------------------------- | --------------------------------------------------------------- |
| `GET /api/push/key`             | —                           | `{ "publicKey" }` — the `applicationServerKey`                  |
| `PUT /api/push/subscription`    | `PushSubscription.toJSON()` | `204`; `400 bad_subscription`; `409 endpoint_taken`             |
| `GET /api/push/subscription`    | —                           | `{ "subscriptions": [{ "id", "createdAt", "lastFailureAt" }] }` |
| `DELETE /api/push/subscription` | `{ "endpoint" }`            | `204` (idempotent)                                              |

Endpoints must be https URLs of a known push service (FCM, Mozilla, Apple, WNS). A phone
keeps at most 5 subscriptions; a sixth replaces the oldest. Endpoints are never returned.

Push is enabled by `RC_VAPID_PUBLIC` + `RC_VAPID_PRIVATE` (and `RC_VAPID_SUBJECT` unless
`RC_ORIGIN` is https). Without them the relay boots with push disabled. Make a key pair:

```sh
node dist/admin.js vapid-keys                            # prints RC_VAPID_PUBLIC=… / RC_VAPID_PRIVATE=…
pnpm --filter @remote-control/relay admin vapid-keys     # local
```

## Audit log and admin counters

The relay writes an `audit_log` row (event, user, device, time — never a body) for
register, login, recovery, enrolment, token rotation, pairing, session revoke, every
forwarded decision (`decision_forwarded`, with the 32-byte decision hash only) and every
push sent (`push_sent`). Writes from the routing path are best-effort and never block it.

`GET /api/admin/counters` (owner only) returns counts: users, live devices by kind,
devices online now, and pushes per UTC day for the last 7 days. It exists only when
`RC_ADMIN_TOKEN` is set (32–256 printable ASCII characters) and a database is configured:

```sh
curl -s -H "Authorization: Bearer $RC_ADMIN_TOKEN" https://<relay>/api/admin/counters
```

It is limited to 10 requests per minute per IP; a wrong token is a 401 and is never logged.

## Device spike (M0-03, temporary)

`RC_SPIKE=1` (needs the VAPID keys, not the database) serves the throwaway device
feasibility page under `/spike/` and `POST /api/spike/push`, which sends the page a test
push after up to 120 s. The procedure and the results live in
[`docs/verification/device-spike.md`](../../docs/verification/device-spike.md). Unset
`RC_SPIKE` after the run; the page and the route are deleted once the verdict is in.

## Error reporting (M0-26, D16)

With `RC_SENTRY_DSN` set, every 5xx handler error (`event:http_error`) and every
uncaught exception or unhandled rejection (level `fatal`, then exit 1 after at most
2 s of flushing) is sent to Sentry. There is no Sentry SDK: the SDK instruments
`http` and attaches requests and breadcrumbs, all of which would need scrubbing. The
relay builds the event from an allow-list (`src/core/error-event.ts`) — exception
types, messages passed through `scrubMessage` (URLs, e-mail addresses, quoted strings
and token-like runs replaced), stack frames, and the tags `event`, `route`, `method`,
`req_id` — and posts it to the DSN's envelope endpoint. No request, user, extra or
context data is ever sent (D19). At most 20 reports per minute; send failures and drops
are logged (`sentry_send_failed`, `sentry_rate_limited`) and never affect requests.

```sh
railway run node dist/admin.js sentry-test               # one test error with a planted canary
```

Operations (alerts, rollback, restore, rotation, cost): [`docs/ops/runbook.md`](../../docs/ops/runbook.md).

## Configuration

See [`.env.example`](../../.env.example). `RC_*` wins over the Railway-provided
fallbacks (`PORT`, `DATABASE_URL`). Invalid values fail fast at startup with the
variable names only — values are never echoed.

## Run locally

```sh
pnpm install
pnpm --filter @remote-control/relay dev        # tsx watch, http://localhost:3000
curl -s localhost:3000/health
```

Without a database URL `/health` reports `"db":"disabled"`. With Postgres:

```sh
docker compose up -d postgres
RC_DATABASE_URL=postgres://rc:rc@localhost:5432/rc pnpm --filter @remote-control/relay dev
```

Production build and image:

```sh
pnpm --filter @remote-control/relay build       # dist/server.js (workspace packages bundled)
pnpm --filter @remote-control/relay start
docker compose up --build                       # Postgres + the relay image on :3000
```

## Phone on the LAN over HTTPS (`pnpm dev:https`)

Service workers and Web Push need a secure context, so a phone testing the PWA against
your machine needs HTTPS with a certificate it trusts.

1. Install mkcert once: `brew install mkcert && mkcert -install`.
2. Trust the mkcert root CA on the phone: the file is in `"$(mkcert -CAROOT)"/rootCA.pem`.
   iOS: AirDrop it, install the profile, then enable it under Settings → General →
   About → Certificate Trust Settings. Android: Settings → Security → Install a
   certificate → CA certificate.
3. From the repository root: `pnpm dev:https`. It writes a certificate for
   `localhost`, `127.0.0.1`, `::1` and the LAN IP into `apps/relay/.certs/`
   (git-ignored) and serves `https://<lan-ip>:3443`. Override with `RC_LAN_IP`,
   `RC_PORT`, or `RC_REGENERATE_CERT=1` after the IP changes.

Passkeys need a host name, not an IP: WebAuthn rejects an IP address as RP ID. The
script sets `RC_RP_ID=localhost` and `RC_ORIGIN=https://localhost:3443`, so passkeys
work at `https://localhost:3443` on the machine itself. For passkeys on the phone, use
a name the phone resolves (for example `mymac.local`): `RC_LAN_IP=mymac.local
RC_REGENERATE_CERT=1 RC_RP_ID=mymac.local RC_ORIGIN=https://mymac.local:3443 pnpm
dev:https`. Plain `http://localhost:3000` also works for passkeys in Chrome and
Firefox, but Safari does not store `Secure` cookies over http, so use HTTPS there.

## Deploy (Railway)

The image is built from the root `Dockerfile` (base pinned by digest, `pnpm deploy
--prod`, runs as `USER node`). Service values (06 §5.1, D15): healthcheck `/health`
with timeout 100 s, restart `ON_FAILURE` × 10, 1 replica, Serverless off,
`overlapSeconds 20`, `drainingSeconds 30` — on SIGTERM `/health` turns 503 and the
process exits within 25 s. `railway.json` records these values; Railway's Config as
Code is deprecated (new services cannot opt in, files stop being read on 2026-12-01),
so set them in the dashboard until `.railway/railway.ts` (IaC) replaces it. The
pre-deploy `node dist/migrate.js` is added with the migrations work package.
