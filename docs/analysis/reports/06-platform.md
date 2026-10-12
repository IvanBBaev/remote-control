# 06 — Platform / DevOps analysis

Status: 2026-10-12. Author: role #6 (Platform / DevOps). Input: `00-brief.md`,
`01-roles.md`, kiko's `railway.json` / `Dockerfile` / `docker-compose.yml` /
`docker-entrypoint.sh` (read-only), and the sources in §9. Interfaces this report
needs from other roles are marked **[needs #N]**.

## 1. Summary

1. One Railway service (`relay`) built from a multi-stage **Dockerfile** (pnpm
   monorepo, `pnpm deploy --prod`), serving the PWA's static build from the same
   Fastify process, plus Railway's **Postgres** over private networking.
2. Service settings live in **`.railway/railway.ts`** (Railway IaC). kiko's
   `railway.json` is reused for its *values* only: Config as Code is deprecated,
   new projects cannot use it, hard cutoff 2026-12-01.
3. **Hobby plan** ($5/mo incl. $5 usage), region Amsterdam, Serverless/sleeping
   **off**, `drainingSeconds` ≥ 30 so open WebSockets close cleanly on deploy.
4. CI: GitHub Actions `ci.yml` (typecheck, lint, test, build, image scan) on PRs
   and `main`; deploys through Railway's **GitHub integration with "Wait for CI"**.
   No `railway up` from CI, no PR environments, no staging until a second real user.
5. Agent published to npm as **`remotectl`** (free name), bundled with **tsdown**
   into one ESM file, `engines.node >=22`, published by **npm trusted publishing**
   (OIDC, no token, provenance automatic), versioned by **release-please**.
6. `remotectl install` registers a user-level service: **launchd** agent (macOS),
   **systemd --user** + linger (Linux), **Task Scheduler ONLOGON task** (Windows).
   Runs as the user; state under `env-paths` directories; logs to files/journal.
7. Nobody-watching observability: pino JSON logs with redaction, Railway
   log/metric retention, **UptimeRobot** (free) on `/health` → e-mail, Railway
   **usage hard limit** + e-mail, optional Sentry free tier on the relay only.
8. Local dev: Postgres via `docker compose`, relay via `tsx watch` on localhost
   (already a secure context), **mkcert** HTTPS only for phone-on-LAN testing.
   The agent's update check notifies, never auto-installs.
9. Cost: ≈ **$6–7/month** in month 1, ≈ **$19–25/month** at 100 users (§5.7).
10. Decide the **production domain before the first passkey is registered**;
    passkeys are bound to the RP ID (domain) and do not survive a domain move.

## 2. Verified facts

Railway (docs.railway.com, fetched 2026-10-12):

- Config as Code (`railway.json`/`railway.toml`) is deprecated; new services
  cannot opt in; existing files stop being read on 2026-12-01. Replacement is
  IaC: one authoring file `.railway/railway.ts` (TS GA; Python/Go beta) using
  `defineRailway`, `project`, `service`, `postgres` from `railway/iac`;
  `railway config init|pull|plan|apply|migrate`; `plan`/`apply` run locally or
  in CI (Railway does not read `.railway/` during deploys); `plan
  --detailed-exit-code` exits 2 on drift. The `railwayapp/config` GitHub Action
  plans on PRs and applies on merge.
  https://docs.railway.com/infrastructure-as-code ,
  https://docs.railway.com/cli/config ,
  https://railway.com/changelog/2026-08-20-railway-anon
- Legacy config fields (used here as the value reference): `builder`
  (DOCKERFILE), `dockerfilePath`, `healthcheckPath`, `healthcheckTimeout`,
  `restartPolicyType` (ON_FAILURE/ALWAYS/NEVER), `restartPolicyMaxRetries`,
  `preDeployCommand`, `overlapSeconds`, `drainingSeconds`, `cronSchedule`,
  per-environment overrides. https://docs.railway.com/reference/config-as-code
- Pricing: Free plan $1 credit/month, 1 replica, 0.5 GB RAM, 1 vCPU, 0.5 GB
  volume, 3-day logs. Trial: one-time $5 for 30 days. Hobby $5/month including
  $5 of usage (fee charged regardless). Pro $20/month. Usage: RAM $10/GB/month,
  CPU $20/vCPU/month, egress $0.05/GB, volume $0.15/GB/month; builds not billed.
  https://docs.railway.com/pricing/plans , https://docs.railway.com/pricing/free-trial
- Usage limits: custom e-mail alert threshold plus a hard limit (minimum $10)
  that stops services; e-mails at 75/90/100 %; all plans.
  https://docs.railway.com/reference/usage-limits
- Public networking specs: HTTP/1.1 and HTTP/2; WebSockets over HTTP/1.1; idle
  HTTP/1.1 connections closed after 60 s between requests; HTTP requests may
  run up to 15 min if data keeps flowing, otherwise closed after 5 min without
  data; request bodies must finish within 5 min; **WebSocket connections are
  exempt from these duration and inactivity limits and can stay open
  indefinitely, even while idle**; 32 KB max combined headers;
  `X-Real-IP`, `X-Forwarded-Proto`, `X-Railway-Request-Id` headers; limits
  10,000 concurrent connections and ~11,000 RPS per domain.
  https://docs.railway.com/networking/public-networking/specs-and-limits
- Health checks: `healthcheckPath` is probed only at deploy time, from host
  `healthcheck.railway.app`, on the injected `PORT`; default timeout 300 s;
  traffic switches only after the check passes (zero-downtime), except services
  with volumes. https://docs.railway.com/deployments/healthchecks
- Deployment lifecycle: new and old deployments overlap; the old one receives
  SIGTERM and is killed after `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` (default 0);
  `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS` configurable.
  https://docs.railway.com/reference/deployments
- Serverless (sleeping) is opt-in per service; "inactive" = no outbound traffic
  for ~5 min; wake on inbound request; cold start can return 502.
  https://docs.railway.com/deployments/serverless
- Private networking: `SERVICE_NAME.railway.internal`, Wireguard mesh, isolated
  per environment. https://docs.railway.com/networking/private-networking
- Postgres: SSL-enabled image based on the official image; provides
  `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE/DATABASE_URL`; public access only
  via TCP proxy (`DATABASE_PUBLIC_URL`, egress billed); no extensions by default.
  https://docs.railway.com/databases/postgresql
- Backups: daily (6 days), weekly (27), monthly (89) plus manual; incremental,
  priced like volume storage; restore only into the same project/environment;
  documented as still under development. https://docs.railway.com/reference/backups
- Volumes: Hobby 5 GB, Free/Trial 0.5 GB, Pro 50 GB; one active deployment per
  volume; `RAILWAY_RUN_UID=0` caveat for non-root images.
  https://docs.railway.com/reference/volumes
- Logs: single-line JSON is parsed (`level` → severity, `msg`/`message`);
  retention Free 3 d / Hobby 7 d / Pro 30 d; 500 lines/s/replica; no log drain.
  Metrics: CPU, memory, disk, network, 30 days, no custom app metrics.
  https://docs.railway.com/reference/logging , https://docs.railway.com/reference/metrics
- Webhooks (deployment status, volume usage, CPU/RAM alerts) → Discord, Slack
  or a URL; no e-mail. https://docs.railway.com/reference/webhooks
- Cron jobs: 5-field UTC crontab, ≥ 5 min spacing, the process must exit; a run
  is skipped while the previous one is active. https://docs.railway.com/reference/cron-jobs
- Pre-deploy command runs between build and deploy in its own container with
  the service's variables, no volumes; non-zero exit fails the deploy.
  https://docs.railway.com/deployments/pre-deploy-command
- GitHub integration: auto-deploy on push to the configured branch; **Wait for
  CI** holds the deploy until Actions workflows conclude; PR environments are a
  project toggle, deleted on merge/close; sealed variables are not copied.
  https://docs.railway.com/deployments/github-autodeploys ,
  https://docs.railway.com/guides/environments
- CLI: `railway up` uploads the directory and builds on Railway; `RAILWAY_TOKEN`
  is an environment-scoped, deploy-only project token; `--service`,
  `--environment`, `--detach`, `--ci`. https://docs.railway.com/cli/deploying
- Dockerfile builds: detected at the service root, `RAILWAY_DOCKERFILE_PATH`
  override; build-time variables need an `ARG` per stage; BuildKit cache mounts
  must use `id=s/<service id>-<path>`. https://docs.railway.com/builds/dockerfiles
- Monorepos: root directory per service; watch paths resolved from `/`.
  https://docs.railway.com/guides/monorepo
- Variables: `${{Service.VAR}}`, `${{shared.KEY}}`; sealed variables cannot be
  read back; available at build time; `RAILWAY_PUBLIC_DOMAIN`,
  `RAILWAY_PRIVATE_DOMAIN`, `PORT`. https://docs.railway.com/reference/variables
- Regions: `us-west2`, `us-east4-eqdc4a`, `europe-west4-drams3a` (Amsterdam),
  `asia-southeast1-eqsg3a`. https://docs.railway.com/deployments/regions
- Public networking: generated `*.up.railway.app` domain; custom domains via
  CNAME + TXT with free, auto-renewed TLS. https://docs.railway.com/networking/public-networking

npm, Node, GitHub, tooling:

- npm trusted publishing: OIDC from GitHub Actions cloud runners; configured per
  package (owner, repo, workflow file name, optional environment); workflow
  needs `permissions: id-token: write` (+ `contents: read`); provenance is
  generated automatically for a public package from a public repo; npm CLI
  ≥ 11.5.1 and Node ≥ 22.14.0; `repository.url` must match; recommended
  "Require two-factor authentication and disallow tokens".
  https://docs.npmjs.com/trusted-publishers
- Provenance: `npm publish --provenance --access public` or
  `publishConfig.provenance`; verify with `npm audit signatures`.
  https://docs.npmjs.com/generating-provenance-statements
- Node lines (schedule.json): v22 LTS, maintenance since 2025-10-21, EOL
  2027-04-30; v24 latest LTS, maintenance from 2026-10-20, EOL 2028-04-30; v26
  current, LTS from 2026-10-28.
  https://github.com/nodejs/Release/blob/main/schedule.json ,
  https://nodejs.org/en/about/previous-releases
- pnpm in CI: official example pins `pnpm/setup` by commit SHA, takes the pnpm
  version from `packageManager`; `--frozen-lockfile` is automatic in CI.
  https://pnpm.io/continuous-integration
- GitHub Actions: free on standard hosted runners for public repositories.
  https://docs.github.com/en/billing/managing-billing-for-your-products/about-billing-for-github-actions
- release-please action: release PR from Conventional Commits, creates tag +
  GitHub Release, outputs `release_created`, `tag_name`,
  `<path>--release_created`; needs `contents: write`, `pull-requests: write`;
  releases made with `GITHUB_TOKEN` do not trigger other workflows.
  https://github.com/googleapis/release-please-action
- changesets/action: version PR + publish script; `id-token: write` for trusted
  publishing; needs "Allow GitHub Actions to create and approve pull requests".
  https://github.com/changesets/action
- tsup README: "not actively maintained anymore ... consider using tsdown";
  tsdown is Rolldown-based and compatible with tsup's main options.
  https://github.com/egoist/tsup , https://tsdown.dev/guide/migrate-from-tsup
- npm names (registry, 2026-10-12): free `remotectl`, `remote-control-agent`,
  `remotectl-agent`, `rc-agent`, `rcagent`, `remoteagent`; taken
  `remote-control` (unrelated, 2022), `rctl`, `agentrc`, `rcx`, `agent-remote`.
  https://registry.npmjs.org/remotectl
- Latest versions (registry, 2026-10-12): tsdown 0.23.1, tsup 8.5.1, pino
  10.4.0, pino-pretty 13.2.0, env-paths 4.0.0, fastify 5.12.5,
  @fastify/websocket 11.3.4, ws 8.22.0, pg 8.23.1, vitest 5.0.4,
  release-please 17.11.2, @railway/cli 5.65.0.

Daemonisation, paths, logging, local HTTPS:

- `launchctl bootstrap|bootout <domain> <plist>`, `enable|disable`,
  `kickstart -k`, `print`; plist keys `KeepAlive` (default false), `RunAtLoad`,
  `ThrottleInterval` (default 10 s), `StandardOutPath`, `StandardErrorPath`,
  `EnvironmentVariables`, `ProcessType`. macOS man pages `launchctl(1)`,
  `launchd.plist(5)` (read locally, macOS 27).
- `loginctl enable-linger USER`: "a user manager is spawned for the user at boot
  and kept around after logouts. This allows users who are not logged in to run
  long-running services." https://github.com/systemd/systemd/blob/main/man/loginctl.xml
- `schtasks /create /sc onlogon /tn <name> /tr <cmd> /rl LIMITED /f` (LIMITED
  is the default run level); `/delay`, `/xml <file>`; a default task shows
  "Stop Task If Runs X Hours and X Mins: 72:0".
  https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks-create
- XDG: `$XDG_STATE_HOME` (`~/.local/state`) is for logs/history and restartable
  state; `$XDG_CONFIG_HOME` → `~/.config`; `$XDG_DATA_HOME` → `~/.local/share`;
  `$XDG_CACHE_HOME` → `~/.cache`. https://specifications.freedesktop.org/basedir/latest/
- `env-paths` 4.0.0: data `~/Library/Application Support/<name>` /
  `%LOCALAPPDATA%\<name>\Data` / `$XDG_DATA_HOME/<name>`; config
  `~/Library/Preferences/<name>` / `%APPDATA%\<name>\Config` /
  `$XDG_CONFIG_HOME/<name>`; log `~/Library/Logs/<name>` /
  `%LOCALAPPDATA%\<name>\Log` / `$XDG_STATE_HOME/<name>`.
  https://github.com/sindresorhus/env-paths
- pino `redact`: array of paths (wildcards `[*]`) or `{paths, censor, remove}`;
  output `"[Redacted]"`. https://github.com/pinojs/pino/blob/main/docs/redaction.md
- Secure contexts: `http://localhost`, `127.0.0.0/8`, `::1`, `*.localhost` are
  potentially trustworthy; Service Workers, Push API, Notifications API and Web
  Authentication API require a secure context.
  https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts ,
  https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts/features_restricted_to_secure_contexts
- Vite: `server.https` takes `https.createServer()` options; `server.host:
  true` exposes to LAN; `@vitejs/plugin-basic-ssl` self-signs but Vite
  recommends your own certificates. https://vite.dev/config/server-options
- mkcert: `mkcert -install` adds a local CA; `mkcert localhost 127.0.0.1 ::1
  <names>`; phones need `rootCA.pem` from `mkcert -CAROOT` installed (iOS:
  profile + enable full trust). https://github.com/FiloSottile/mkcert
- `pg_dump` refuses servers newer than its own major version; `-Fc` custom
  format restores with `pg_restore`. https://www.postgresql.org/docs/current/app-pgdump.html
- Free tiers: UptimeRobot 50 monitors, 5-min interval, no card; Better Stack 10
  monitors/heartbeats, e-mail + Slack; Healthchecks.io 20 checks; Sentry
  Developer $0, 1 user, 5k errors/month, e-mail alerts.
  https://uptimerobot.com/pricing/ , https://betterstack.com/uptime/pricing ,
  https://healthchecks.io/pricing/ , https://sentry.io/pricing/

kiko (local, read-only): `railway.json` = `DOCKERFILE` builder, `healthcheckPath
/health`, `healthcheckTimeout 100`, `ON_FAILURE` × 10 retries; two-stage
`node:22-slim` Dockerfile pinned by digest, `gosu` entrypoint only because kiko
owns a volume; CI = `npm run check`, `npm audit --omit=dev --audit-level=high`,
Trivy on the image (HIGH, CRITICAL, exit 1).

## 3. Assumptions

- A1. Railway's edge keeps idle WebSockets open (verified), but mobile carriers'
  NAT and home routers drop idle TCP after ~5–10 min. Design as if idle
  WebSockets *will* be dropped: application ping every 25 s, reconnect.
- A2. Private networking is IPv6-first; bind Fastify to `::` (dual-stack) so
  `railway.internal` and the public proxy both reach it. Not on the fetched page.
- A3. Railway backups are available on Hobby (the page lists no plan gate).
  Verify on day one; if gated, the `pg_dump` cron (W10) becomes mandatory.
- A4. Railway's Postgres template provisions Postgres 17; the `pg_dump` client
  in a cron service must be the same or newer major.
- A5. Railway ignores Docker `HEALTHCHECK`; only `healthcheckPath` matters. The
  Dockerfile keeps one for local `docker compose`.
- A6. A standard (non-admin) Windows user can create an ONLOGON task for
  themselves; the docs' "only Administrators can schedule tasks" sentence sits
  in the System-account section. Test on a non-admin account (W13).
- A7. On macOS, `~/.claude` is not TCC-protected (unlike Desktop/Documents/
  Downloads), so a launchd user agent reads it without Full Disk Access. The
  settings file is `~/.claude/settings.json` **[needs #4]**.
- A8. Corepack ships with Node 22 but is slated for removal from later Node
  distributions; the Dockerfile and CI install pnpm explicitly.
- A9. pnpm 10 does not run dependency lifecycle scripts unless allow-listed
  (`pnpm.onlyBuiltDependencies`), reducing supply-chain exposure in CI.
- A10. The free `*.up.railway.app` domain is fine for the owner's own use, not
  for external users (§5.1, RP ID).
- A11. Idle WebSocket connections cost ≈ 20–50 KB RAM each in Node; 300
  concurrent connections fit the 0.6 GB budget in §5.7.
- A12. Trivy, UptimeRobot, Sentry and Healthchecks.io free tiers stay free at
  this scale; none is load-bearing — each can be dropped without redesign.

## 4. Findings

- **H: one Railway service + Postgres, hobby/free tier.** *Changed.* One
  service is right. The **Free plan is not**: $1/month credit, 0.5 GB RAM for
  the workspace and 3-day logs cannot host a relay plus Postgres that must stay
  up. Hobby ($5/month) is the floor; the Trial's one-time $5 covers only a first
  30 days of experimentation.
- **H: agent on npm, run with `npx`.** *Confirmed with a caveat.* `npx remotectl
  pair` is the right first contact. The daemon needs a stable path: `npx`
  caches are pruned and drift between runs. `remotectl install` therefore runs
  `npm i -g remotectl@<same>` when it detects an npx-cache location and points
  the service file at the global binary and the current `process.execPath`.
- **H: relay serves the PWA.** *Confirmed.* `@fastify/static` serves
  `apps/web/dist` with immutable cache headers for hashed assets and `no-cache`
  for `index.html`, manifest and service worker. One origin for WebAuthn,
  cookies and Web Push.
- **H: Railway as the WebSocket meeting point.** *Confirmed; the proxy itself
  does not drop idle WebSockets (§2).* Operational requirements remain: deploys
  must drain (default `drainingSeconds` 0 → immediate SIGKILL); pending
  permission requests must be durable in Postgres, not in memory **[needs #3]**;
  Serverless stays off (a sleeping relay answers the first approval of the day
  with a 502).
- **H: "Railway sees only metadata".** *Confirmed from the platform side*:
  Railway logs only what the app writes to stdout; the redaction list in §5.5
  makes the promise hold operationally **[needs #2 for the final field list]**.
- **H: Node 22.** *Confirmed as the agent's minimum* (`engines.node >=22`).
  Node 22 is in maintenance, EOL 2027-04-30; image and CI move to 24 in H1
  2027 (W21).
- **Brief Q9 (distribution, keep-alive, updates).** Answered in §5.3–§5.4: npm
  + user-level OS services + notify-only update check. Auto-update is rejected
  for MVP: a daemon that replaces its own code is a supply-chain amplifier and
  the hardest thing to debug remotely.
- **CI deploy path.** `railway up` from Actions is rejected for the GitHub
  integration with "Wait for CI": no long-lived project token in GitHub
  secrets, no CLI pinning, Railway already builds from the commit.
- **PR environments.** Rejected for one developer: each PR duplicates relay +
  Postgres (billed), sealed variables are not copied, and the feature under
  test (phone ↔ home machine) needs a paired agent anyway.

## 5. Recommendations

### 5.1 Railway topology and configuration

- Project `remote-control`, environment `production`, region
  `europe-west4-drams3a` (owner and first users are in Europe; approval
  round-trips are latency-sensitive). Alternatives: `us-west2` — latency; two
  regions — not needed.
- Services: `relay` (Dockerfile, 1 replica) and `Postgres` (Railway template).
  Later, optional: `pg-dump` cron service.
- Builder: **Dockerfile** (kiko pattern, adapted). Alternatives: Railpack —
  zero-config for pnpm workspaces, but the image must contain two workspace
  apps (relay + web build) pruned to production; a Dockerfile makes that
  explicit, reproducible locally and scannable by Trivy. Nixpacks — superseded
  by Railpack.
- Dockerfile shape: `FROM node:22-bookworm-slim@sha256:<digest>` in both stages
  (digest bumped by Dependabot); build stage `npm i -g pnpm@<packageManager
  version>`, copy lockfile + manifests, `pnpm fetch` with a BuildKit cache mount
  `id=s/<service id>-/root/.local/share/pnpm/store`, `pnpm install
  --frozen-lockfile --offline`, `pnpm -r build`, `pnpm --filter
  @remote-control/relay deploy --prod /out/relay`, copy `apps/web/dist` to
  `/out/relay/public`; runtime stage copies `/out/relay`, `ENV
  NODE_ENV=production`, `USER node` (no volume → no gosu/entrypoint), `CMD
  ["node","dist/server.js"]`. Fastify listens on `PORT`, host `::`.
- Settings authored in `.railway/railway.ts` (values mirror kiko): healthcheck
  `/health`, timeout 100 s, restart `ON_FAILURE` max 10, `drainingSeconds: 30`,
  pre-deploy `node dist/migrate.js`, watch paths `apps/relay/**`, `apps/web/**`,
  `packages/**`, `Dockerfile`, `pnpm-lock.yaml`. Applied with `railway config
  apply` from the owner's machine; CI runs `railway config plan
  --detailed-exit-code` on PRs touching `.railway/**` (drift gate) via the
  `railwayapp/config` action. Alternative: dashboard-only — loses
  reviewability, which is what kiko's `railway.json` existed for.
- Postgres: `${{Postgres.DATABASE_URL}}` (private host), no TCP proxy, pool
  ≤ 10. TLS to the private host is redundant (Wireguard); if the driver
  insists, `sslmode=disable` for the `railway.internal` host only.
- Domain: `*.up.railway.app` for the owner's own phase; a custom domain (CNAME
  + TXT, free TLS) **before the first external passkey**. WebAuthn credentials
  are bound to the RP ID; a later move means every user re-registers
  **[needs #2 to confirm RP ID policy]**.
- Serverless off; 1 replica (the WS hub is in-process; multi-replica needs a
  pub/sub layer **[needs #3]**, not for MVP).
- Backups: enable Railway backups on Postgres and do one restore drill into a
  temporary environment. Add the `pg-dump` cron service only if A3 fails or
  once the first external user exists: `postgres:<same major>-alpine`,
  `cronSchedule "0 3 * * *"`, `pg_dump -Fc` to a Railway bucket or external
  S3-compatible bucket, ping Healthchecks.io, exit. Alternative: `pg_dump`
  from GitHub Actions — needs the public proxy and a DB secret in GitHub; rejected.

### 5.2 CI/CD

- `ci.yml` on `pull_request` and `push: main`: `actions/checkout` (pinned),
  `pnpm/setup` (pinned SHA, `runtime: node@22`, `cache: true`), `pnpm install
  --frozen-lockfile`, `pnpm check` (typecheck + lint + format:check + test +
  build), `pnpm audit --prod --audit-level=high`; a second job builds the image
  and runs Trivy (HIGH, CRITICAL, exit 1) — from kiko. Matrix: ubuntu for
  relay/web; the agent's tests also on macos and windows runners (free on a
  public repo) because the daemon code is OS-specific.
- `main` protected: PRs required, `ci` required status check, linear history.
- Deploy: Railway GitHub integration on `main` with **Wait for CI**. Rollback =
  redeploy the previous deployment in the dashboard.
- PR environments off. Staging: none until a second real user; then a
  `staging` environment via Duplicate Environment, deploying a `staging`
  branch, same IaC file with an environment override.

### 5.3 Agent distribution and releases

- Name `remotectl` (free), bin `remotectl`; fallback `@remote-control/agent`
  if the owner prefers a scope. Reserve with a `0.0.1` placeholder in week 1.
- Bundle with **tsdown** to one ESM file (`dist/cli.js` with shebang),
  `target: node22`, `platform: node`, no externals (self-contained, so `npx`
  installs nothing else), sourcemaps on. Alternatives: tsup — unmaintained;
  plain `tsc` — leaves a dependency tree for `npx` to install on every machine
  (slow, larger attack surface); esbuild directly — fine, tsdown adds d.ts and
  config handling. `package.json`: `type: module`, `engines.node ">=22"`,
  `files: ["dist"]`, exact `repository.url`, `publishConfig {access: public,
  provenance: true}`, no `postinstall`.
- Publishing: **npm trusted publishing** from `release.yml` (workflow name
  registered in the package settings), `permissions: id-token: write,
  contents: read`, Node ≥ 22.14 / npm ≥ 11.5.1; package setting "Require 2FA
  and disallow tokens". No `NPM_TOKEN` ever exists.
- Versioning: **release-please** manifest mode (components `apps/agent`,
  `apps/relay`, `packages/protocol`, `apps/web`), Conventional Commits, one
  release PR per component; `release.yml` publishes the agent on
  `apps/agent--release_created`. Alternatives: changesets — better for many
  contributors writing changeset files; manual `npm version` — no changelog, no
  provenance workflow.
- Compatibility: the agent sends its version + protocol version at connect; the
  relay answers `min_supported` **[needs #3]** and may refuse older agents with
  a clear message — the only forced-upgrade mechanism.
- Update check: on start and every 24 h, `GET
  https://registry.npmjs.org/-/package/remotectl/dist-tags` (ETag cached, 5-s
  timeout, failures silent). If `latest` > running: warn in the log, show in
  `remotectl status`, send `update_available` to the relay so the phone shows a
  badge. Opt out with `REMOTECTL_NO_UPDATE_CHECK=1`. Never download or replace
  code; `remotectl update` = `npm i -g remotectl@latest` + service restart, run
  by the user.

### 5.4 Keeping the agent alive

Subcommands `remotectl install | uninstall | status | run | logs`. `install`
writes a service definition that executes `<process.execPath> <abs cli.js>
run` as the current user with `PATH` and `HOME` set explicitly (launchd and
Task Scheduler start with a minimal environment).

- macOS: `~/Library/LaunchAgents/dev.remotectl.agent.plist` with `KeepAlive
  true`, `RunAtLoad true`, `ThrottleInterval 10`, `ProcessType Background`,
  stdout/stderr → `~/Library/Logs/remotectl/agent.log`; `launchctl bootstrap
  gui/$UID <plist>`, `bootout gui/$UID/dev.remotectl.agent`, `kickstart -k`.
  Alternative: login item / menu-bar app — not a daemon, not scriptable.
- Linux: `~/.config/systemd/user/remotectl.service` (`Restart=always`,
  `RestartSec=5`, `WantedBy=default.target`); `systemctl --user daemon-reload
  && systemctl --user enable --now remotectl`; `loginctl enable-linger $USER`
  so it survives logout and starts at boot (may prompt via polkit — on failure
  print the command for the user). Logs: journald + the file log for
  `remotectl logs` parity. Alternative: system unit — root, not the user;
  rejected (must read `~/.claude`).
- Windows: Task Scheduler task from XML (`schtasks /create /xml`): `LogonTrigger`
  for the current user, `ExecutionTimeLimit PT0S` (the 72-h default would kill
  the daemon), `RestartOnFailure` (PT1M × 999), `MultipleInstancesPolicy
  IgnoreNew`, `Hidden`, run level LIMITED, "run only when logged on". A tiny
  `wscript` wrapper only if a console window appears (W13). Alternatives:
  NSSM/WinSW — admin + third-party binary; `node-windows` — admin system
  service without the user's profile; rejected.
- Paths (`env-paths('remotectl', {suffix: ''})`): device keys and pairing
  state in `paths.data` (`0600`), config in `paths.config`, logs in `paths.log`
  (10 MB × 5 via `pino-roll`), update cache in `paths.cache`. `uninstall`
  removes the service; `--purge` removes the directories.
- Supervision: the daemon never exits on relay disconnect; it reconnects with
  jittered backoff 1 s → 60 s. Exit is reserved for fatal config errors, so
  `KeepAlive`/`Restart=always` cannot loop-crash.

### 5.5 Observability for an unwatched service

- Logging: pino with `level` as a label (`formatters.level`) so Railway
  classifies severity; fields `req_id` (= `X-Railway-Request-Id`), `user_id`
  (opaque), `device_id`, `event`, `bytes`, `duration_ms`, `ws_close_code`,
  `ws_reconnects`. Redact `req.headers.authorization`, `req.headers.cookie`,
  `*.token`, `*.secret`, `*.payload`, `*.ciphertext`, `*.push_endpoint`,
  `*.challenge`, `*.pairing_code`, `*.password`. **Never** log message payloads
  (encrypted or not), push endpoints (capability URLs), WebAuthn challenges or
  assertions, pairing codes, full user agents at `info`. Agent: same logger to
  file; hook payload contents only at `debug`, off by default.
- `/health`: `{status, version, commit, db}`; 503 when `SELECT 1` fails within
  2 s. Used by Railway at deploy and by UptimeRobot every 5 min → e-mail.
  Alternative: Better Stack — fine too; UptimeRobot has 50 free monitors and
  needs no card.
- Railway usage: hard limit $15, e-mail alert at $8. Optional webhook → Discord
  for deployment failures.
- Errors: Sentry Developer on the relay only (5k errors/month, e-mail),
  `beforeSend` strips request bodies. Nothing in the agent beyond the update
  check. Alternative: none — then the only error signal is a 7-day log window;
  too thin for a service nobody watches.
- Backup heartbeat: Healthchecks.io pinged by the `pg-dump` cron (if deployed).

### 5.6 Environments

- Local: `docker compose up -d` starts `postgres:17-alpine` only (named
  volume, port 5432, `.env` from `.env.example`); relay on the host with `tsx
  watch | pino-pretty` (kiko pattern); PWA `vite dev` on
  `http://localhost:5173` proxying `/api` and `/ws` — `localhost` is a secure
  context, so service worker, Web Push and WebAuthn work on desktop without
  TLS. Agent: `REMOTECTL_RELAY_URL=ws://localhost:3000`.
- Phone on the LAN: `pnpm dev:https` = Vite `server.https` with mkcert
  certificates for a hostname (not an IP — RP IDs are domains), e.g.
  `dev.remotectl.test` via `/etc/hosts` and the phone's DNS (or a real subdomain
  A record pointing at the LAN IP); `rootCA.pem` installed on the phone once.
  Alternative: test phone flows only against Railway — slower loop, acceptable.
- Staging: none at MVP (§5.2).

### 5.7 Cost

Hobby rates (§2), 1 replica, no public DB proxy.

| Item | Month 1 (owner only) | 100 users (~30 % online) |
|---|---|---|
| Railway Hobby fee (includes $5 usage) | $5.00 | $5.00 |
| relay RAM (0.25 GB → 0.6 GB avg) | $2.50 | $6.00 |
| relay CPU (0.05 → 0.25 vCPU avg) | $1.00 | $5.00 |
| Postgres RAM (0.2 → 0.4 GB) + CPU | $2.50 | $5.00 |
| Volume (0.5 → 2 GB) + backups | $0.10 | $0.60 |
| Egress (<1 GB → ~20 GB) | $0.05 | $1.00 |
| Usage subtotal | $6.15 | $17.60 |
| **Railway bill** (fee + usage above $5) | **$6.15** | **$17.60** |
| Domain (amortised) | $0 (Railway domain) | ~$1.25 |
| GitHub Actions, npm, UptimeRobot, Sentry, Healthchecks | $0 | $0 |
| **Total** | **≈ $6–7** | **≈ $19–25** |

Month 1 could be ≈ $1 on the one-time Trial, but its 0.5 GB RAM cap makes a
relay + Postgres pair marginal; take Hobby from day one. At 100 users the first
scaling step is RAM, not a plan change.

## 6. Risks

| # | Risk | L | I | Mitigation |
|---|---|---|---|---|
| R1 | Config as Code cutoff (2026-12-01) breaks a copied `railway.json` workflow; the IaC SDK is new and may change | M | M | `.railway/railway.ts` from day one; dashboard as fallback source of truth; pin `@railway/cli`. |
| R2 | Idle WebSockets dropped by carrier NAT / home routers (A1); Railway's edge is verified not to | M | H | App-level ping/pong 25 s, reconnect with backoff on agent and PWA, durable pending requests in Postgres **[needs #3]**, `ws_reconnects` in logs (UptimeRobot cannot see this). |
| R3 | Redeploy kills in-flight permission requests | H if ignored | H | `drainingSeconds 30`; on SIGTERM close WS with 1012 and persist state; clients resend unacknowledged decisions; forward-only migrations. |
| R4 | Postgres data loss (single volume, no HA) | L | H | Railway backups + restore drill; `pg-dump` cron if A3 fails; relay holds metadata only, so loss ≠ compromise. |
| R5 | Cost spike (reconnect storm, egress bug) | M | M | Hard usage limit $15 + e-mail at $8; per-device connect rate limit **[needs #3]**; 1 replica. |
| R6 | npm supply chain / publisher account takeover | L | H | Trusted publishing only, tokens disallowed, 2FA, provenance, lockfile, A9 script policy, Trivy + `pnpm audit`, single-file bundle with zero runtime deps. |
| R7 | Windows daemon: console window, task killed, non-admin cannot create task (A6) | M | M | XML task with `ExecutionTimeLimit PT0S` + `Hidden`; test on a non-admin account early (W13); Windows `install` may ship one iteration later. |
| R8 | `npx` cache pruning or version drift breaks the installed service | M | M | `install` performs a global install and points the service at a stable path; `status` reports path + version. |
| R9 | Node 22 EOL 2027-04-30 | certain | L | Keep `>=22` for users; image/CI to Node 24 in H1 2027 (W21). |
| R10 | Domain change invalidates all passkeys | M | H | Buy the production domain before the first external user. |
| R11 | Nobody reads alerts | M | M | All alerts to e-mail (UptimeRobot, Railway usage, Sentry); keep the set tiny so each one means something. |
| R12 | Free-tier tools change terms | M | L | None is load-bearing (A12); swap or drop. |

## 7. Work items

Sizes: S ≤ ½ day, M ≤ 2 days, L ≤ 1 week. Gate = `pnpm check` green.

1. **Root tooling** (S) — pnpm workspace, `packageManager`, `engines`, shared
   tsconfig/eslint/prettier, `pnpm check`. Dep: none. AC: `pnpm check` exits 0
   with the four packages scaffolded.
2. **CI workflow** (S) — `ci.yml` per §5.2. Dep: 1. AC: green on a PR; `ci`
   is a required status check on `main`.
3. **Image scan + audit job** (S) — Trivy on the built image, `pnpm audit
   --prod --audit-level=high`. Dep: 2, 5. AC: fails on an injected vulnerable
   dependency in a test PR, passes on `main`.
4. **docker-compose Postgres + `.env.example`** (S) — Dep: 1. AC: `docker
   compose up -d && pnpm --filter relay dev` serves `/health` 200, `db: ok`.
5. **Dockerfile + `.dockerignore`** (M) — per §5.1. Dep: 1, relay/web
   skeletons **[needs #3, #5]**. AC: cold `docker build` < 5 min; image
   < 300 MB; `docker run -e PORT=3000 -e DATABASE_URL=…` answers `/health` and
   serves `/index.html`; `whoami` in the container prints `node`.
6. **Railway project + IaC file** (M) — project, Postgres, `relay` service from
   the repo, region, sealed variables, "Wait for CI"; `.railway/railway.ts`
   with §5.1 settings; drift-gate job. Dep: 2, 5. AC: `railway config plan
   --detailed-exit-code` exits 0 after `apply`; a push to `main` deploys and
   passes the healthcheck; dashboard shows `drainingSeconds 30`.
7. **Health endpoint** (S) — per §5.5. Dep: relay skeleton. AC: tests for
   200/503; response carries `version` and `RAILWAY_GIT_COMMIT_SHA`.
8. **Graceful shutdown** (S) — SIGTERM: stop accepting, close WS with 1012,
   flush, exit within 25 s. Dep: 7. AC: integration test opens a WS, sends
   SIGTERM, asserts close code 1012 and exit 0 within 30 s.
9. **Migrations as pre-deploy command** (S) — `dist/migrate.js`, forward-only
   **[needs #3 for the tool]**. Dep: 6. AC: a failing migration deployed to a
   temporary environment fails the deploy and leaves the old deployment serving.
10. **Backups** (S, +M optional) — enable Railway backups; restore drill;
    optional `pg-dump` cron + Healthchecks.io. Dep: 6. AC: a restored database
    answers `SELECT count(*)` with production's value; drill in the runbook.
11. **Structured logging + redaction** (S) — shared pino config (tiny
    `packages/log`). Dep: 1. AC: test asserts `headers.authorization` and
    `payload` print `[Redacted]`; Railway log explorer shows severities.
12. **Alerts** (S) — UptimeRobot on `/health`, Railway alert $8 / hard limit
    $15, Sentry DSN (sealed). Dep: 6, 7. AC: stopping the service 10 min
    yields an UptimeRobot e-mail; a thrown test error reaches Sentry without a
    request body.
13. **Agent `install`/`uninstall`/`status`** (L) — launchd, systemd --user +
    linger, Task Scheduler XML; `env-paths` layout; npx-cache detection with
    global install. Dep: agent `run` **[needs #4]**, 14. AC: on each OS the
    process is running after logout/login and back within 30 s after `kill
    -9`; `uninstall --purge` leaves no files or service entries; a non-admin
    Windows account succeeds (A6).
14. **Agent build + package metadata** (M) — tsdown single-file ESM, shebang,
    `bin`, `files`, `engines`, `repository`, `publishConfig`. Dep: 1. AC: `npm
    pack` tarball < 2 MB with only `dist/`, `package.json`, `README`; `npx
    ./remotectl-*.tgz --version` works on Node 22 and 24.
15. **Release automation** (M) — release-please manifest, `release.yml` with
    trusted publishing, npm package settings (2FA, tokens disallowed, trusted
    publisher). Dep: 14, 2. AC: merging the release PR publishes
    `remotectl@0.1.0` with a provenance badge; `npm audit signatures` passes;
    no `NPM_TOKEN` in repo secrets.
16. **Name reservation** (S) — publish `remotectl@0.0.1` placeholder. Dep: 14
    (minimal). AC: `npm view remotectl` shows the owner's account.
17. **Update check** (S) — per §5.3. Dep: 14. AC: unit test with a mocked
    registry covers newer/equal/offline; `remotectl status` prints the line.
18. **Agent log files + rotation** (S) — `pino-roll` 10 MB × 5, `remotectl
    logs -f`. Dep: 11, 13. AC: 60 MB of logs leave ≤ 5 files; `logs` tails
    the newest.
19. **Local HTTPS for phone testing** (S) — `pnpm dev:https`, mkcert docs.
    Dep: 4, web skeleton. AC: an iPhone on the LAN installs the PWA and the
    service worker registers (reviewer check).
20. **Ops runbook** (S) — `docs/ops/runbook.md`: deploy, rollback, restore,
    rotate sealed secrets, alert meanings, IaC apply. Dep: 6, 10, 12. AC: a
    reviewer performs a rollback from the doc alone.
21. **Node 24 migration** (S, 2027-Q1) — image digest, CI matrix; `engines`
    unchanged until Node 22 EOL. Dep: none. AC: CI green on 24.
22. **Dependabot** (S) — weekly, grouped minor/patch for npm, Actions and the
    Docker base image. Dep: 2. AC: first grouped PR passes CI.

Suggested order: 1, 2, 4, 7, 11, 5, 6, 8, 9, 12, 14, 16, 15, 17, 13, 18, 10,
19, 20, 3, 22; 21 later.

## 8. Open questions for the owner

1. **Package name** `remotectl` (unscoped, free) — default **yes**, reserve
   now; alternative `@remote-control/agent` if a scope is preferred.
2. **Production domain**: buy one now (≈ $10–15/year) and attach it before any
   external user registers a passkey — default **yes**; the owner picks it.
3. **Plan**: Hobby from day one vs. Trial first — default **Hobby**.
4. **Region**: Amsterdam (`europe-west4-drams3a`) — default **yes**.
5. **Error tracking**: Sentry free tier on the relay only — default **yes**;
   never in the agent.
6. **Agent network calls besides the relay**: only the npm dist-tags update
   check, env opt-out — default **yes**.
7. **Windows `install` in MVP**: macOS + Linux first, Windows `install` one
   iteration later while `remotectl run` already works there — default **all
   three in MVP, in that order**, Windows allowed to slip.
8. **npm publisher account**: the account owning `servicenow-mcp-ai` (npm user
   `syncrona`) or a dedicated one — default **same account**, 2FA enforced.
9. **Discord webhook for deploy failures** — default **no** (e-mail suffices).

## 9. Sources

- Railway: https://docs.railway.com/infrastructure-as-code ,
  https://docs.railway.com/cli/config , https://docs.railway.com/cli/deploying ,
  https://railway.com/changelog/2026-08-20-railway-anon ,
  https://docs.railway.com/reference/config-as-code ,
  https://docs.railway.com/pricing/plans , https://docs.railway.com/pricing/free-trial ,
  https://docs.railway.com/reference/usage-limits ,
  https://docs.railway.com/networking/public-networking/specs-and-limits ,
  https://docs.railway.com/networking/public-networking ,
  https://docs.railway.com/networking/private-networking ,
  https://docs.railway.com/deployments/healthchecks ,
  https://docs.railway.com/reference/deployments ,
  https://docs.railway.com/deployments/serverless ,
  https://docs.railway.com/databases/postgresql ,
  https://docs.railway.com/reference/backups , https://docs.railway.com/reference/volumes ,
  https://docs.railway.com/reference/logging , https://docs.railway.com/reference/metrics ,
  https://docs.railway.com/reference/webhooks , https://docs.railway.com/reference/cron-jobs ,
  https://docs.railway.com/deployments/pre-deploy-command ,
  https://docs.railway.com/deployments/github-autodeploys ,
  https://docs.railway.com/guides/environments , https://docs.railway.com/builds/dockerfiles ,
  https://docs.railway.com/guides/monorepo , https://docs.railway.com/reference/variables ,
  https://docs.railway.com/deployments/regions
- npm / Node / GitHub: https://docs.npmjs.com/trusted-publishers ,
  https://docs.npmjs.com/generating-provenance-statements ,
  https://registry.npmjs.org/remotectl (and sibling name lookups),
  https://github.com/nodejs/Release/blob/main/schedule.json ,
  https://nodejs.org/en/about/previous-releases , https://pnpm.io/continuous-integration ,
  https://docs.github.com/en/billing/managing-billing-for-your-products/about-billing-for-github-actions ,
  https://github.com/googleapis/release-please-action , https://github.com/changesets/action ,
  https://github.com/egoist/tsup , https://tsdown.dev/guide/migrate-from-tsup
- Daemons / paths / logging: macOS man pages `launchctl(1)`, `launchd.plist(5)`;
  https://github.com/systemd/systemd/blob/main/man/loginctl.xml ,
  https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks-create ,
  https://specifications.freedesktop.org/basedir/latest/ ,
  https://github.com/sindresorhus/env-paths ,
  https://github.com/pinojs/pino/blob/main/docs/redaction.md
- Local HTTPS / web platform: https://github.com/FiloSottile/mkcert ,
  https://vite.dev/config/server-options ,
  https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts ,
  https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts/features_restricted_to_secure_contexts
- Postgres: https://www.postgresql.org/docs/current/app-pgdump.html
- Monitoring tiers: https://uptimerobot.com/pricing/ ,
  https://betterstack.com/uptime/pricing , https://healthchecks.io/pricing/ ,
  https://sentry.io/pricing/
- Local, read-only: `~/Development/kiko/railway.json`, `Dockerfile`,
  `docker-compose.yml`, `docker-entrypoint.sh`, `.github/workflows/ci.yml`
