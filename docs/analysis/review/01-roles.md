# As-built review — 01. Roles (2026-10-29)

The review is done by senior specialists, each auditing the **existing** code, tests and
docs in their field. The v1 role set (`docs/analysis/01-roles.md`) was chosen to plan a
product that did not exist yet. This set is chosen to audit one that does. It differs from
v1 in four ways:
- the native app now exists (ADR 0017), so it needs its own reviewer;
- the codebase is about 42 k lines, so modularity is now a real concern;
- the release is blocked on evidence, not code, so release readiness has its own lens;
- product strategy was already done in v2/v3, so product is reviewed as-built only, meaning the flows and copy that ship.

## Dispatched roles
| # | Role | Why this project needs it | Scope (owns) | Report |
|---|---|---|---|---|
| 01 | **Security & cryptography architect** | Everything rests on I1–I4. The as-built crypto, UV binding and decision verification must match the design. | `packages/crypto`, decision/assertion checks in the agent, relay authority surfaces, privacy gate, `SECURITY.md`, key storage (agent files, PWA IndexedDB, Secure Enclave) | `reports/01-security.md` |
| 02 | **Backend / relay engineer** | The relay is the only server and runs as a single replica on Railway. | `apps/relay`: HTTP routes, WS hub, PgNotifyHub, migrations, limits, shutdown, push senders (Web Push and APNs) | `reports/02-relay.md` |
| 03 | **Agent-integration engineer** | The agent is the largest unit and sits on unstable vendor surfaces (hooks, `--bg`, Codex, Gemini, SDK). | `apps/agent` minus its CLI ergonomics: adapters, hook receiver, pending store, session hub, launcher, relay link | `reports/03-agent.md` |
| 04 | **Native iOS / mobile engineer** | The Expo app with Swift targets (Secure Enclave, NSE, widgets) is new, has thin tests and has never run on a device. | `apps/mobile` including `modules/`, `targets/`, the Expo config and the native build | `reports/04-mobile.md` |
| 05 | **Web / PWA frontend engineer** | The PWA is the fallback client and the M1 release surface. iOS PWA limits shape it. | `apps/web`, `packages/phone-core` (shared with mobile), service worker, accessibility, i18n readiness | `reports/05-web.md` |
| 06 | **Platform, DevOps & release engineer** | Release is blocked on deploy, publish and ops evidence. CI and supply chain must be ready on the day the owner unblocks it. | `.github/workflows`, `Dockerfile`, `railway.json`, `tools/`, `docs/ops/`, `docs/release-checklist.md`, npm packaging, dependency policy | `reports/06-platform.md` |
| 07 | **QA & test architect** | 2 672 tests is a lot. Their value, gaps, flakiness risk and manual-only evidence need a critical look. | test strategy across all units: `packages/test-harness`, `packages/fake-claude-code`, `e2e/`, coverage config, verification records | `reports/07-qa.md` |
| 08 | **TypeScript / monorepo architect** | The size and the parallel v3 lanes make modularity, layering (ports and adapters) and package boundaries the main maintainability risk. | workspace layout, tsconfig/build graph, package boundaries, file sizes, dependency direction, public API of packages, duplication between apps | `reports/08-architecture.md` |
| 09 | **Product & UX lead (as-built)** | The second-user run and the M1 exit judge what ships. The flows, copy, onboarding and docs must be ready for a stranger. | shipped flows on the PWA and the app, onboarding/pairing, error and empty states, README, `docs/product/`, CLI messages | `reports/09-product-ux.md` |

## Considered, not dispatched
| Role | Reason |
|---|---|
| Privacy / legal | There is no account e-mail, no telemetry and no payload storage. The privacy questions are technical, so they are folded into 01 (privacy gate, logs, Sentry scrubbing) and 06 (data retention, backups). A privacy policy or terms only matter before a public App Store listing. 09 flags it if needed. |
| SRE / on-call | This is a single-owner hobby deployment (Q12) with no live service yet. 06 covers the runbook, alerts and drills. |
| Android engineer | Android native is gated (Q-V3-7). The PWA on Chrome Android is covered by 05. |
| Visual designer | v1 already folded this into product and PWA. 09 covers the visual consistency of the as-built screens. |
| Performance engineer | The load numbers (soak, hook overhead) are QA evidence (07). Relay hot paths go to 02. |

## Rules for every reviewer
- **Format:** English, one file, at most about 500 lines. Use the section order of the v3
  reports: Summary (≤ 10 lines) · Verified facts · Assumptions · Findings · Recommendations
  (with rejected alternatives) · Risks · Work items · Open questions for the owner (with
  defaults) · Sources.
- **Evidence:** every finding cites `path:line` or a command and its output. A finding with
  no evidence goes under Assumptions.
- **Severity:** each finding is graded `critical` / `high` / `medium` / `low`.
- **Do not repeat earlier analyses.** Do not re-propose items that already exist in
  ROADMAP, v2 or v3. Cite their IDs. An as-built defect in an area that a v3 item will
  rewrite is noted with the v3 ID, not duplicated.
- **Work items:**
  - ID `RV-<area>-NN` (areas: SEC, RLY, AGT, MOB, WEB, OPS, QA, ARC, UX);
  - each has a size (S = 1 h, M = 2 h, L = 4 h of Opus 5.5), deps and a machine-checkable AC;
  - each names the files it touches. Paths owned by a v3 lane (`v3/PARALLEL.md` §2) are
    marked with that lane.
- **Read-only:** no edits outside the reviewer's own report, and no commits.
