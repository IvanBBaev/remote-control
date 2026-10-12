# @remote-control/relay

Fastify 5 relay: serves the PWA, the API and (later) the WebSocket hub from one
origin. It sees metadata only (invariants I1–I4). Ports & adapters layout:

| Path                            | Role                                                                 |
| ------------------------------- | -------------------------------------------------------------------- |
| `src/core/`                     | Pure logic (`healthReport`, `DrainState`).                           |
| `src/ports/`                    | Interfaces the core depends on (`DatabaseHealth`).                   |
| `src/adapters/`                 | Implementations (`pg`, system clock). The only place for `Date.now`. |
| `src/http/`                     | Routes: `/health`, `/api/version`, static PWA + SPA fallback.        |
| `src/config.ts`                 | Zod-validated `RC_*` environment.                                    |
| `src/container.ts`              | Wires adapters from config.                                          |
| `src/app.ts`                    | `buildApp(deps)` — the testable Fastify factory.                     |
| `src/main.ts` / `src/server.ts` | Composition root and process entry.                                  |

## Endpoints

- `GET /health` — `200 {"status":"ok",...}` while serving; `503 "degraded"` when
  `SELECT 1` fails (2 s timeout); `503 "draining"` once shutdown has started (D15).
  Logged at `warn` only, so Railway's probes stay out of the info log.
- `GET /api/version` — `{ version, commit, protocol: { id, v, minSupported } }`.
- Static PWA from `RC_PUBLIC_DIR` (default `apps/web/dist`): `/assets/*` immutable for a
  year, everything else `no-cache`; an unknown `GET` accepting `text/html` outside
  `/api`, `/ws` and `/health` gets `index.html`; anything else is a JSON 404. A
  missing build is tolerated (JSON 404 only).

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

## Deploy (Railway)

The image is built from the root `Dockerfile` (base pinned by digest, `pnpm deploy
--prod`, runs as `USER node`). Service values (06 §5.1, D15): healthcheck `/health`
with timeout 100 s, restart `ON_FAILURE` × 10, 1 replica, Serverless off,
`overlapSeconds 20`, `drainingSeconds 30` — on SIGTERM `/health` turns 503 and the
process exits within 25 s. `railway.json` records these values; Railway's Config as
Code is deprecated (new services cannot opt in, files stop being read on 2026-12-01),
so set them in the dashboard until `.railway/railway.ts` (IaC) replaces it. The
pre-deploy `node dist/migrate.js` is added with the migrations work package.
