# 06 — Platform, DevOps & release review (OPS)

Reviewer role: platform / DevOps / release engineer. Scope: `.github/workflows/*`,
`Dockerfile`, `.dockerignore`, `railway.json`, `tools/release.ts`, `docs/ops/runbook.md`,
`docs/release-checklist.md`, npm packaging of `remotectl`, ADR 0003 / 0011 / 0016,
secrets, M0-26 backups and monitoring, and the "Q2 / Q15 unblock day". Read-only review,
2026-10-29.

## 1. Summary

- **M1 release (remotectl@0.1.0 + relay on Railway): ready-with-fixes.** The npm side is
  in good shape: the tarball policy is enforced by code, the bundle runs with zero
  runtime deps on Node 22 and 26, and provenance and trusted publishing are wired up. The
  Railway side is not a checklist run yet.
- **Native app TestFlight: not ready.** The APNs configuration is undocumented, and the
  work is gated on Q22, Q23 and M4-08. V3-C11 / v2 P-12 own the workflow.
- The top blocker is that `railway.json` will be **ignored** by any Railway service created
  after 2026-08-28. All Config as Code stops on 2026-12-01. D16 named `.railway/railway.ts`,
  and the repo never migrated to it. Health check, pre-deploy migrate, drain and overlap,
  restart policy and watch paths would all silently disappear on Q2 day.
- There is no single ordered day-one procedure. The documented admin commands
  (`railway run node dist/admin.js …`) do not work as written.
- The release workflow publishes any `remotectl-v*` tag after `pnpm check` alone. It does
  not check that the commit is on main or that the other CI lanes passed.
- Findings: 0 critical, 3 high, 5 medium, 5 low. 12 work items.

## 2. Verified facts

| # | Fact | Evidence |
|---|---|---|
| V1 | The release runs on tag `remotectl-v*` with `contents: write` and `id-token: write`. Steps in order: pnpm check, then pack, then `tools/release.ts verify`, then `npm publish <tgz> --provenance --access public`, then an install retry plus `npm audit signatures`, then `gh release create --verify-tag`. | `.github/workflows/release.yml:9,55,57-67,72` |
| V2 | The npm version gate rejects only `a<11 \|\| (a===11&&b<5)`, so 11.5.0 passes. Trusted publishing needs npm ≥ 11.5.1. | `.github/workflows/release.yml:38` |
| V3 | No step in release.yml checks that the tagged commit is reachable from `main` or that the `ci` / `agent-os` / `image` / e2e checks are green for that SHA. | `release.yml` read in full (72 lines) |
| V4 | `ci.yml` runs frozen install, `pnpm audit --prod --audit-level=high`, `pnpm audit signatures` and `pnpm check`. It also runs a Docker build with Trivy (pinned by SHA), plus the agent-os matrix (3 OS × node 22/24) and the `agent-os` aggregator. Other actions are pinned by tag (`@v4`…`@v7`). | `.github/workflows/ci.yml:34,37,39,52,116-122` |
| V5 | `e2e.yml` has the jobs `browser-crypto`, `playwright` and `webkit` (macOS). The runbook CI table lists no `webkit`. | `e2e.yml`; `docs/ops/runbook.md:28-34` |
| V6 | `railway.json` sets builder DOCKERFILE, watchPatterns `apps/relay/**, apps/web/**, packages/**, Dockerfile, pnpm-lock.yaml`, preDeploy `node dist/migrate.js`, `/health` with a 100 s timeout, ON_FAILURE ×10, overlap 20, draining 30, and staging `numReplicas: 2`. No `.railway/` directory exists. | `railway.json:1-25`; `ls .railway` → absent |
| V7 | Railway: `railway.json`/`railway.toml` are deprecated in favour of `.railway/railway.ts`. Services created after 2026-08-28 cannot opt into file-based Config as Code, and existing files stop being read on 2026-12-01. The migration is `railway config migrate` → `pull` / `plan` / `apply`. | Sources S1–S3 |
| V8 | The runbook mentions the 2026-12-01 cutoff only for the staging replica count. | `docs/ops/runbook.md:81-82` |
| V9 | Dockerfile: the base image is pinned by digest, pnpm is installed with `npm install --global pnpm@11.11.0` without an integrity check, and the build uses fetch → offline install → `pnpm deploy --prod --legacy`. The runtime stage drops npm/npx/corepack, runs `apt-get upgrade`, runs as `USER node`, and starts with `CMD node dist/server.js`. | `Dockerfile:4,9,31` |
| V10 | `remotectl` manifest: version 0.0.0, `bin: dist/cli.mjs`, `files: ["dist"]`, `engines >=22`, no `dependencies`, `publishConfig {access: public, provenance: true}` with exports `./package.json` only, and `peerDependenciesMeta` for `@anthropic-ai/claude-agent-sdk` but **no `peerDependencies`**. | `apps/agent/package.json:36-40` |
| V11 | `tools/release.ts` enforces the name, an x.y.z version that matches the tag, not private, `files === ["dist"]`, a bin, no install or prepare scripts, no dependencies, the repository url and directory, and publishConfig. The tarball may hold only package.json, README/LICENSE and `dist/*.(mjs\|cjs\|js\|map)`, and must contain cli.mjs and hook.cjs. `workspace:` ranges and `src/` exports are rejected. The checks are unit-tested. | `tools/release.ts`; `tools/release.test.ts` |
| V12 | The built bundle runs with no `node_modules` nearby. A copy of `dist/cli.mjs` placed in the scratchpad runs `--version`, which prints `0.0.0` (exit 0) on Node 26.12.1 and 22.23.0. Sizes: cli.mjs 2.46 MB, cli.mjs.map 4.39 MB (shipped), hook.cjs 4.5 KB. The only true external is the dynamic import of claude-agent-sdk. | Commands run in the scratchpad |
| V13 | pnpm config: `minimumReleaseAge: 10080`, `allowBuilds: esbuild: false`, and `auditConfig.ignoreGhsas` = GHSA-mrhx-c7xc-m3w5 (zod via @expo/cli) and GHSA-86w9-cpqp-85rv (node-forge), with the comment "Remove this entry … after 2026-11-03". | `pnpm-workspace.yaml` |
| V14 | Relay env: `RC_APNS_KEY`, `RC_APNS_KEY_ID`, `RC_APNS_TEAM_ID` and `RC_APNS_TOPIC` must be set together, and `RC_SPIKE` enables the spike page. None of them is in `.env.example`, and `git grep RC_APNS -- docs` has no hits. | `apps/relay/src/config.ts:45-60,118-124`; `.env.example` |
| V15 | The port resolution order is `RC_PORT` → `PORT` → 3000, and the commit SHA comes from `RAILWAY_GIT_COMMIT_SHA`. | `apps/relay/src/config.ts:17-19,27,220` |
| V16 | Invite minting is documented as `railway run node dist/admin.js invite`. The runbook says its commands run "from the repository root", but `dist/admin.js` exists only under `apps/relay/dist/`. | `apps/relay/README.md:64-69`; `docs/ops/runbook.md` header, `188-199` |
| V17 | The runbook rollback section says "Migrations are forward-only (M0-03)", but migrations are M0-08. The secret-rotation table says "device revocation is a later work package", although M1-10 is done (ADR 0009). | `docs/ops/runbook.md:122-129,201-211` |
| V18 | The suggested branch protection uses `enforce_admins: false`, and the owner pushes straight to `main`. | `docs/ops/runbook.md:46-53`; `git log` |
| V19 | The release checklist covers placeholder 0.0.1 (M0-27), a trusted publisher (repo, `release.yml`, no environment), "Require 2FA and disallow tokens" and tag protection. The flow is branch → `pnpm release:version` → PR → merge → tag. There are no concrete placeholder-publish steps. | `docs/release-checklist.md:1-60` |
| V20 | `docs/verification/m0-exit.md` criterion 3 says "installed via npx … kept alive by launchd", but ADR 0002 makes `install` refuse to run from an npx cache. | `docs/verification/m0-exit.md`; `docs/adr/0002-*` |
| V21 | Secrets scan of tracked files (private keys, npm/gh/Anthropic tokens, credentialed postgres URLs, Sentry DSNs) found only test fixtures (`rc:secret@db`, `canary-password@127.0.0.1:1`, the GitHub example token in `push-summary.test.ts:39`). `.env` is ignored (`.gitignore:5`), `.env.example` has empty values, and docker-compose uses local `rc/rc`. | `git grep -nIE …` (see §9) |
| V22 | `.dockerignore` excludes node_modules, dist, .git, .github, .env*, docs and harness files, but not `apps/mobile/`. Because of `COPY . .` the mobile sources reach the build context. | `.dockerignore` |
| V23 | ADR 0003 (tag-driven trusted publishing) is still `proposed`. ADR 0011: Node 24 for the image and CI, floor 22. ADR 0016: staging with 2 replicas and `RC_HUB=pg`, still pending the owner. | `docs/adr/0003-*`, `0011-*`, `0016-*` |

## 3. Assumptions

- A1: The production Railway service and project do not exist yet (Q2 is open, and M0-02b and M0-26b are `blocked-owner`), so they will be created after 2026-08-28.
- A2: The owner stays the only committer and pushes directly to `main`. This is consistent with the WORKLOG and the git log.
- A3: `railway run` runs the command **locally** with the service's variables injected. On a Railway-provisioned Postgres, `DATABASE_URL` points at the private `*.railway.internal` host, which a laptop cannot reach. This comes from the Railway docs. I did not verify it against a live project.
- A4: npm trusted publishing needs the package to exist before a trusted publisher can be configured. That is why a 0.0.1 placeholder is published by hand once (D22, M0-27).
- A5: Mapping `RC_DATABASE_URL` to `${{Postgres.DATABASE_URL}}` is the intended Railway setup. Today the runbook implies it but never states it.

## 4. Findings

### F1 — `railway.json` is dead config for the service Q2 day will create (high)
- **Evidence:** V6, V7, V8, A1. D16 specifies `.railway/railway.ts`. The repo ships `railway.json`, and no ADR records the deviation.
- **Why it matters:** A new service ignores the file completely. These settings would be lost:
  - the `/health` gate, so a broken build goes live;
  - the pre-deploy migrate (D17 still migrates at boot, which softens this);
  - the ON_FAILURE restart policy and overlap and draining, so in-flight WebSockets are cut on every deploy (I2);
  - the watch patterns and the staging replica count (ADR 0016).

  The owner would have to copy every setting into the dashboard by hand, which is exactly the engineering session the day was supposed to avoid. After 2026-12-01 even old services lose the file.
- **Touches:** D15, D16, D17, I2, ADR 0016, R14.

### F2 — No ordered day-one (Q2 + Q15) procedure (high)
- **Evidence:** The steps are spread over the runbook, `apps/relay/README.md`, `.env.example`, ROADMAP M0-02 / M0-26 / M0-27 and `docs/release-checklist.md`. There is no single ordered list from "buy domain" to "first passkey registered + monitors green".
- **Why it matters:** Order matters, and some steps cannot be undone:
  - `RC_RP_ID` / `RC_ORIGIN` must be final before the first passkey is created (R6), so the custom domain has to exist before anyone registers.
  - The VAPID keys must exist before the first push subscription; rotating them invalidates every subscription.
  - The trusted publisher can only be added after the placeholder exists (A4).
  - "Wait for CI" and the usage limits must be set before the first auto-deploy.
- **Touches:** R6, D16, D22, M0-02b, M0-26b, M0-27b, M1-09b.

### F3 — The documented admin commands fail as written (high)
- **Evidence:** V16, A3. `railway run node dist/admin.js invite` breaks in two ways:
  - (a) It resolves `dist/admin.js` against the repo root, where the file does not exist.
  - (b) It connects to `postgres.railway.internal` from the laptop.

  The same applies to `sentry-test` (the M0-26 drill) and to `vapid-keys`. `vapid-keys` needs no database, so only the path problem affects it.
- **Why it matters:** Invites are the only way to register the first user (M0-09 is invite-only). On Q2 day the owner would end up debugging Railway networking. The fix is to use `railway ssh` into the running container (`node dist/admin.js …` there, with cwd `/app`), or a local build with `RC_DATABASE_URL=$DATABASE_PUBLIC_URL`.
- **Touches:** M0-26, M1-09b, D16.

### F4 — Release workflow does not gate on `main` or on CI (medium)
- **Evidence:** V3, V18. Any `remotectl-v*` tag on any commit, including a branch commit that was never merged, publishes once `pnpm check` passes on one Ubuntu runner. The agent-os matrix (the only real launchd, systemd and schtasks coverage), the image scan and e2e are not required. Tag protection is a manual checklist item, and `enforce_admins: false` means branch protection does not gate the owner.
- **Why it matters:** This is a supply-chain and quality gap on the one artifact users install (I4). A provenance attestation proves *where* the package was built, not that the commit was reviewed or tested.
- **Touches:** D13, R13, I4, ADR 0003.

### F5 — No concrete placeholder (0.0.1) publish procedure (medium)
- **Evidence:** V19, A4. The checklist says "publish placeholder 0.0.1", but it does not say from which directory, with what `package.json` or README, with `npm publish --access public` and 2FA, or that a later `npm deprecate remotectl@0.0.1` is needed. The flow also assumes a PR, which contradicts A2.
- **Why it matters:** Q15 day turns into an improvisation on the one manual, token-bearing publish. A wrong placeholder, for example a non-empty package or a `bin` that resolves, stays forever (npm unpublish rules).
- **Touches:** D13, D22, M0-27b, R13.

### F6 — APNs and spike variables are undocumented (medium)
- **Evidence:** V14. `.env.example` and the runbook do not list `RC_APNS_*` or `RC_SPIKE`. The rotation table has no APNs `.p8` row. The runbook does not say that the sandbox/production choice comes from the device token (`push-routes.ts:48`).
- **Why it matters:** This blocks a TestFlight push end-to-end (M4-08). Setting only some of the four variables makes the relay refuse to boot (`config.ts:118-124`), which is a deploy-day outage.
- **Touches:** D5, M4-08, Q22, Q23, R14.

### F7 — `ignoreGhsas` has a dated removal with no enforcement (medium)
- **Evidence:** V13. The comment says to remove the node-forge and zod ignores "after 2026-11-03" (five days from now). Nothing fails when that date passes.
- **Why it matters:** A silent permanent audit waiver on the dependency-security gate (`ci.yml:34`). Once the upstream fix ships, the ignore keeps masking any regression.
- **Touches:** D13, R13.

### F8 — Runbook drift (medium)
- **Evidence:** V5, V16, V17.
  - The runbook says "M0-03" where it means M0-08.
  - It still calls device revocation "later", although that shipped.
  - It says to run commands from the repo root, but they need `apps/relay`.
  - The CI table has no `webkit` row.
  - Branch protection is shown with `enforce_admins:false` and no explanation of what it protects in a single-committer repo.
- **Why it matters:** The runbook is what the owner follows on the bad day. Every wrong line costs trust in the rest of it.
- **Touches:** M0-26.

### F9 — Optional peer declared only in `peerDependenciesMeta` (low)
- **Evidence:** V10. Without a `peerDependencies` entry, npm and pnpm ignore the meta block. The SDK is loaded dynamically, and the README tells users to install it globally.
- **Why it matters:** No version range is expressed, so `npm ls` and dependency-review tools cannot warn about an incompatible SDK. The package metadata does not match the code's "optional peer" comment.
- **Touches:** D13, D23.

### F10 — npm version gate off by one (low)
- **Evidence:** V2. The gate allows npm 11.5.0, but OIDC trusted publishing needs 11.5.1 or later.
- **Why it matters:** A theoretical runner image on 11.5.0 fails at publish with a confusing auth error instead of failing at the gate.
- **Touches:** D13.

### F11 — `watchPatterns` miss root inputs (low)
- **Evidence:** V6. Root `package.json`, `pnpm-workspace.yaml` (overrides, `minimumReleaseAge`), `.nvmrc`, `.dockerignore` and the Railway config itself are not watched.
- **Why it matters:** A security override bump does not redeploy the relay. This becomes moot if F1 moves the config into `railway.ts`, but the same list has to be carried over.
- **Touches:** D16.

### F12 — Image build not reproducible (low)
- **Evidence:** V9, V22. `apt-get upgrade` makes the layer change with time, pnpm is installed without an integrity pin, and `apps/mobile/` is in the build context.
- **Why it matters:** The same commit can produce different images, and Trivy results then differ between CI and Railway's own build. The extra context makes builds slower.
- **Touches:** D13, R13.

### F13 — `m0-exit.md` contradicts ADR 0002 (low)
- **Evidence:** V20. The exit criterion "installed via npx" describes a path that `install` deliberately refuses.
- **Why it matters:** The verification run on Q2 day would fail on its own template.
- **Touches:** I4, ADR 0002.

## 5. Recommendations

1. **F1: migrate to `.railway/railway.ts` before Q2 day, and record an ADR.** Write it by hand from `railway.json`, since `railway config migrate` needs a linked project. Keep `railway.json` only until the service is linked, then delete it. Add a unit test that imports the TS config and asserts the D16 values (health path and timeout, preDeploy, restart policy, overlap and draining, region, replicas, watch paths).
   - *Rejected:* configure the dashboard by hand and document the values. This drifts and cannot be checked.
   - *Rejected:* keep `railway.json`. It is ignored for new services.
2. **F2: one ordered `docs/ops/day-one.md` with a checkbox per step**, split into a Q15 track (npm) and a Q2 track (domain + Railway), with explicit "point of no return" markers (RP ID, VAPID). Add a test that every `process.env.RC_*` read in `apps/relay/src/config.ts` appears in `.env.example`.
   - *Rejected:* grow the runbook further. The runbook is for operating, not bootstrapping, and is already 238 lines.
3. **F3: replace `railway run` with `railway ssh -- node dist/admin.js …`** for database commands. Keep `railway run` only for `vapid-keys` (no database), with `cd apps/relay` first, or use `pnpm --filter @remote-control/relay admin`.
   - *Rejected:* expose a public `DATABASE_PUBLIC_URL` permanently. It widens the attack surface for a weekly operation.
4. **F4: add a `gate` job to `release.yml`** (not lane-owned) that `publish` needs. It should:
   - fetch `origin/main` and check `git merge-base --is-ancestor $GITHUB_SHA origin/main`;
   - then `gh api repos/{repo}/commits/$GITHUB_SHA/check-runs` and require `ci`, `agent-os` and `image` to be `success`.
   - *Rejected:* `workflow_run` chaining. It loses the tag context and complicates OIDC.
   - *Rejected:* a GitHub environment with required reviewers. The trusted publisher was registered with "no environment", the owner is the only reviewer, and V3-S07 already covers deployment protection.
5. **F5:** a scripted, reviewable placeholder (`tools/placeholder/` with a minimal `package.json`: no bin, no files, a README that says "reserved") plus exact commands in the release checklist. Rewrite the checklist flow for direct-to-main.
6. **F6:** add the APNs and spike variables to `.env.example` and a runbook APNs section (provisioning, sandbox vs production, `.p8` rotation). The config-coverage test from rec. 2 keeps this in sync.
7. **F7:** a test that fails after the dated deadline unless the entry is gone or the date is extended. Parse `pnpm-workspace.yaml` comments or move the date into a structured `expires` sidecar.
   - *Rejected:* a calendar reminder. It is not machine-checkable.
8. **F9–F13:** small hygiene edits, listed in §7. Pinning GitHub Actions by SHA is a `ci.yml` change and belongs to the `version-gate` lane, so it is listed only as a lane-owned item.

## 6. Risks (new)

| ID | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| R-OPS-1 (extends R14) | The Railway platform deprecates Config as Code, and settings are silently lost on the first deploy, so health checks and draining are absent. | High / high | RV-OPS-01 |
| R-OPS-2 (extends R13) | A tag on an untested or unmerged commit publishes to npm with valid provenance. | Low / high | RV-OPS-04 |
| R-OPS-3 (extends R6) | The owner registers the first passkey on the `*.up.railway.app` host before the custom domain is live, and the passkey is stranded on that domain. | Medium / medium | RV-OPS-02, step ordering |
| R-OPS-4 (extends R13) | A dated audit waiver outlives its reason. | Medium / medium | RV-OPS-06 |
| R-OPS-5 | Partial APNs configuration means the relay refuses to boot during a TestFlight rollout. | Medium / high | RV-OPS-05 |

## 7. Work items

Lane ownership: `.github/workflows/ci.yml` belongs to the v3 `version-gate` lane; `README.md` and `tools/vendor-watch*` belong to `evidence`; `mobile-release.yml` belongs to `clients` (V3-C11). Items that are already planned are not repeated here: V3-C03 (gateway deploy/runbook), V3-S07 (deployment protection), v2 P-1 (4-replica soak), v2 P-12 / V3-C11 (mobile release), M0-26b (backup/Sentry drills), M0-27b (reserve the name).

| ID | Title | Size | Deps | Files touched | AC (machine-checkable) | Finding |
|---|---|---|---|---|---|---|
| RV-OPS-01 | Port Railway settings to `.railway/railway.ts` plus an ADR for the transition | L | — | `.railway/railway.ts` (new), `railway.json` (remove after link), `docs/adr/00NN-railway-config-ts.md` (new), `tools/railway-config.test.ts` (new), `docs/ops/runbook.md` | `test -f .railway/railway.ts`; the test asserts healthcheckPath `/health`, timeout 100, preDeploy `node dist/migrate.js`, restart ON_FAILURE/10, overlap 20, draining 30, staging replicas 2, and that watch paths include `pnpm-workspace.yaml`; `pnpm check` green | F1, F11 |
| RV-OPS-02 | Ordered day-one checklist (Q15 track, Q2 track) | M | RV-OPS-03 | `docs/ops/day-one.md` (new), link from `docs/ops/runbook.md` | The file exists; `grep -c '^- \[ \]' docs/ops/day-one.md` ≥ 20; it contains the strings `RC_RP_ID`, `Wait for CI`, `trusted publisher`, `railway ssh` and `UptimeRobot` | F2 |
| RV-OPS-03 | Fix the admin command docs (`railway ssh`, `apps/relay` path) | S | — | `apps/relay/README.md`, `docs/ops/runbook.md` | `git grep -n "railway run node dist/admin.js" -- '*.md'` returns 0 lines; `railway ssh` appears ≥ 2 times | F3 |
| RV-OPS-04 | Release `gate` job: tag on `main` plus required checks green | M | — | `.github/workflows/release.yml` | `publish` has `needs: gate`; `gate` contains `merge-base --is-ancestor` and a `check-runs` call naming `ci`, `agent-os` and `image`; `actionlint` passes | F4 |
| RV-OPS-05 | Document the APNs and spike variables and add a config-coverage test | S | — | `.env.example`, `docs/ops/runbook.md`, `apps/relay/src/config-coverage.test.ts` (new) | The test fails if any `RC_[A-Z_]+` read in `config.ts` is missing from `.env.example`; `grep -c RC_APNS .env.example` = 4 | F6, F2 |
| RV-OPS-06 | Expiry test for `auditConfig.ignoreGhsas` | S | — | `pnpm-workspace.yaml`, `tools/audit-waivers.test.ts` (new) | The test fails when today > the waiver date and the GHSA is still listed; each ignored GHSA has an `expires` date | F7 |
| RV-OPS-07 | Placeholder publish kit and a direct-to-main release checklist | S | — | `tools/placeholder/package.json` (new), `tools/placeholder/README.md` (new), `docs/release-checklist.md` | `npm pack --dry-run tools/placeholder` lists only package.json and README.md; the placeholder has no `bin`; the checklist contains `npm publish --access public` and `npm deprecate` and no `PR` step | F5 |
| RV-OPS-08 | Runbook drift fixes | S | — | `docs/ops/runbook.md` | `grep -c "M0-03" docs/ops/runbook.md` = 0 in the migration line; "later work package" is absent; the CI table includes `webkit` | F8 |
| RV-OPS-09 | Declare the optional peer correctly | S | — | `apps/agent/package.json`, `tools/release.ts` (+test) | `peerDependencies["@anthropic-ai/claude-agent-sdk"]` exists, and `release.ts verify` checks that every key of `peerDependenciesMeta` exists in `peerDependencies` | F9 |
| RV-OPS-10 | Fix the npm version gate to ≥ 11.5.1 | S | — | `.github/workflows/release.yml` | The gate expression rejects `11.5.0` and accepts `11.5.1` (a unit test of the extracted script or an inline `node -e` self-test) | F10 |
| RV-OPS-11 | Image reproducibility and context trimming | S | — | `Dockerfile`, `.dockerignore` | No `apt-get upgrade` in `Dockerfile`; pnpm comes from corepack with a pinned hash or uses `npm i --global pnpm@11.11.0 --integrity` style verification; `.dockerignore` contains `apps/mobile` | F12 |
| RV-OPS-12 | Align `m0-exit.md` criterion 3 with ADR 0002 | S | — | `docs/verification/m0-exit.md` | `grep -n "via npx" docs/verification/m0-exit.md` returns no match in criterion 3; the text names `npm i -g remotectl` | F13 |
| (lane `version-gate`) | Pin the remaining `ci.yml` actions by SHA | — | — | `.github/workflows/ci.yml` **[version-gate lane]** | Hand to the lane; not proposed as an OPS item | F12 |

Total size: 1 L (RV-OPS-01), 2 M (RV-OPS-02, RV-OPS-04) and 9 S, about 17 h.

## 8. Open questions for the owner

1. **OQ-OPS-1:** Is the custom domain purchased *before* the Railway service is created, so that `RC_RP_ID` is final from the first boot? *Default: yes. Never register a passkey on `*.up.railway.app`.*
2. **OQ-OPS-2:** Is a GitHub ruleset with `enforce_admins: true` acceptable for `remotectl-v*` tags and `main`, or does the owner keep direct pushes? *Default: keep direct pushes, protect tags only, and rely on the RV-OPS-04 gate.*
3. **OQ-OPS-3:** For admin commands: `railway ssh` into production, or a temporary public database URL? *Default: `railway ssh`, with no public database endpoint.*
4. **OQ-OPS-4:** Ship `cli.mjs.map` (4.4 MB) in the npm tarball? *Default: keep it. Stack traces help support, and size is not a D13 concern.*
5. **OQ-OPS-5:** Does staging (ADR 0016) get its own Railway project, or an environment in the same project? *Default: an environment in the same project, which is what the existing config models.*

## 9. Sources

- S1 Railway Help Station, "railway.toml has no effect — what replaces it": https://station.railway.com/questions/railway-toml-has-no-effect-what-replac-b623aa81
- S2 Railway docs, Config as Code: https://docs.railway.com/reference/config-as-code
- S3 Railway docs, CLI `config`: https://docs.railway.com/cli/config
- S4 Secondary write-up on the Railway config migration: https://www.issoh.co.jp/tech/details/17485/
- Repository files cited inline in §2 (paths and line numbers as of `f0281ef`).
- Commands run, all read-only:
  - `node dist/cli.mjs --version` and `--help` on a scratch copy, with Node 26.12.1 and 22.23.0.
  - The secrets scan: `git grep -nIE "BEGIN (EC |RSA |OPENSSH )?PRIVATE KEY|npm_[A-Za-z0-9]{30,}|ghp_[A-Za-z0-9]{20,}|sk-ant-…|postgres(ql)?://user:pw@|sentry DSN"`.
  - `git check-ignore -v .env`.
  - `ls .railway`.
