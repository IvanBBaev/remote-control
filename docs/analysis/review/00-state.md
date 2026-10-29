# As-built review — 00. State of the project (2026-10-29)

Snapshot at `main` = `f0281ef`. This corpus is an **as-built audit**: it looks at the code,
tests, gates and documents that exist today. It does not redo the earlier analyses —
`docs/analysis/` (v1, the build plan), `docs/analysis/v2/` (post-MVP direction) and
`docs/analysis/v3/` (3.0 direction) — it cites them. Reports live in `reports/`, the
consolidated findings in `SYNTHESIS.md`, the work items in `ROADMAP-review.md`.

## 1. What the product is
Approve, answer and start AI coding agent sessions (Claude Code first, then Codex, Gemini
and the Claude Agent SDK) from a phone. Three runtime parts:
- **relay** (`apps/relay`): Fastify + Postgres on Railway; accounts (passkeys), pairing,
  WebSocket hub, Web Push and APNs. Metadata only; it never sees plaintext.
- **agent** (`apps/agent`, published as `remotectl`): the home daemon. It installs hooks,
  holds pending requests, runs the E2E sessions with phones, launches sessions and runs as
  an OS service.
- **phone**:
  - the PWA (`apps/web`);
  - the Expo native iOS app (`apps/mobile`, ADR 0017), with a Secure Enclave device key,
    a notification service extension, widgets and Control Center;
  - the logic both share lives in `packages/phone-core`.

Binding invariants (ROADMAP §1, quoted short):
- I1 — nothing runs on the user's machine because the relay said so; every
  machine-touching action is a decision from a paired phone, bound to the exact request;
- I2 — the agent never leaves Claude Code hanging; undecidable requests are released or
  denied before the hook timeout, and an undeliverable decision is dropped, never queued;
- I3 — the relay sees metadata only: no bodies, transcripts, readable push content or
  payload log lines;
- I4 — the agent installs from one `npx` command, keeps itself running and never
  auto-updates.

## 2. Code inventory
Non-test TS/TSX lines under `src/`, and the number of test files:

| Unit | Src lines | Test files | Notes |
|---|---|---|---|
| `apps/agent` | 12 676 | 74 | Largest unit. The biggest files are `cli/main.ts` (1 156 lines) and `core/session-hub.ts` (985). |
| `apps/relay` | 10 147 | 31 | Includes `core/pg-notify-hub.ts` (576) and `core/relay-router.ts` (570). Drizzle migrations. |
| `apps/web` | 4 802 | 41 | Vite PWA, service worker, Playwright suite in `e2e/`. |
| `apps/mobile` | 3 132 (+657 Swift) | 7 | Expo SDK 58; the `device-key` native module; `notification-service` and `widgets` targets. |
| `packages/phone-core` | 2 752 | 1 | Shared phone logic. `realtime/realtime-client.ts` is 812 lines, with a single test file. |
| `packages/fake-claude-code` | 2 398 | 4 | Fake CLI and conformance suite. |
| `packages/test-harness` | 2 168 | 28 | Journeys, soak runner, dev session. |
| `packages/protocol` | 1 922 | 19 | zod schemas, version negotiation, hidden-character reveal. |
| `packages/crypto` | 1 591 | 6 | Noise KK/XXpsk0; WebCrypto and noble backends. |
| `packages/log` | 216 | 1 | Logger with redaction. |

Other facts:
- **Tests:** the last `pnpm check` (2026-10-28, after M4-04) ran 2 672 tests: all passed, 8 skipped.
- **History:** 189 commits since 2026-10-12, 41 of them since 2026-10-18.
- **Code markers:** no `TODO`/`FIXME` markers in `apps/*/src` or `packages/*/src`.
- **CI** (`.github/workflows/`):
  - `ci.yml`: jobs `ci`, `image`, `agent-os-matrix`, `agent-os`;
  - `e2e.yml`: jobs `browser-crypto`, `playwright`, `webkit`;
  - `pg-real.yml`;
  - `release.yml`: tag-driven npm publish with provenance (ADR 0003).
- **ADRs:** 0001–0017 are accepted. 0018–0022 are reserved for v3 lanes (`v3/PARALLEL.md` §4); 0023 and later are first come.
- **Verification records** (`docs/verification/`):
  - adapters: `claude-code-hooks`, `claude-sdk`, `codex`, `gemini`;
  - spikes and exits: `device-spike`, `m0-exit`, `m1-exit`;
  - usage and load: `m1-usage`, `second-user`, `soak`;
  - native app: `native-app` (M4-01…M4-05, M4-07, with screenshots and an XCUITest).

## 3. Roadmap status
**Main roadmap (`docs/analysis/ROADMAP.md`).** Release target: M1 exit, meaning
`remotectl@0.1.0` is published and the M1 exit record exists. Progress is 88 %. 11.6 h
remain, and 11.2 h of that is blocked on the owner.

| Milestone | State |
|---|---|
| M0 walking skeleton | All code parts done. The following are `blocked-owner`: domain and Railway deploy (M0-02b), device spike (M0-03b), real-CLI runs (M0-23b), backups and monitoring (M0-26b), npm placeholder (M0-27b), branch protection (PUSHc), M0 exit record. |
| M1 second user | All code parts done. The following are `blocked-owner`: real-CLI checks (M1-04b/05b/07b), first tagged publish (M1-09b), second-user run (M1-14b), 24 h soak (M1-15b), M1 exit record. |
| M2 beyond Claude Code | M2-01…M2-09 done. Several carry pending manual checks: the Codex real-CLI log, the M2-04 iOS/Android QR check, and the M2-09 real-CLI check. |
| M3 backlog | Node 24, Gemini, PgNotifyHub, transcript backfill, claude-sdk and staging: done, outside the release target. |
| M4 native app | M4-01, 02, 03, 04 and 07 are done. M4-05 is `partial:80` (simctl run, per-option buttons). M4-06 (Live Activity) is todo. M4-08 (TestFlight) is todo, gated on Q2 and Q22. |

**v2 (`v2/ROADMAP-v2.md`).** Every item is `todo` or `gated`. Gating inputs:
- a real claude CLI (V2-AG-01);
- owner answers to Q-P1 and Q-P5.

**v3 (`v3/ROADMAP-v3.md`).**
- **Done:** V3-S03, V3-S03b, V3-S03c and V3-S03d (card phishing hardening).
- **Gated or todo:** everything else.
- **Lane rules:** set in `v3/PARALLEL.md`.

## 4. What is verified and what is not
**Verified by automated gates.** These run on every `pnpm check` or CI run:
- typecheck, lint and format;
- unit and integration tests, with the coverage thresholds from Q20;
- the journeys and the privacy gate (M0-22);
- the Playwright suite P1–P9 and the WebKit smoke;
- `pg-real` against a real Postgres;
- the OS matrix for the agent;
- image build and audit.

**Verified once, by hand:**
- M4 simulator runs (M4-01…M4-05, M4-07), with screenshots and an XCUITest kept outside CI;
- the synthetic hook overhead (p95 31.9 ms);
- the Codex, Gemini and claude-sdk adapter checks recorded in `docs/verification/`.

**Never verified in the real world:**
- **Production:** there is no production domain or Railway deploy yet (Q2), so there have been no passkeys on a real RP ID and no real Web Push or APNs delivery.
- **Devices:** there has been no run on a physical device, either for the PWA spike (M0-03b) or the native app (M4-08, which needs the Apple Developer Program, Q22).
- **Real Claude Code:** the hold of 11 minutes or more, the version gate, and A2/A3 have not been exercised against the real CLI (M0-23b).
- **Release:** nothing has been published to npm, and branch protection is off.
- **Long-running and multi-user:** there has been no 24 h soak and no second user.

## 5. Observations that seed the role reviews
1. **The code is ahead of the evidence.** Almost all remaining release work is owner-gated
   evidence, not code. The risk is drift: code written against assumptions that real
   devices or the real CLI might invalidate (R1, R3, R4).
2. **Large files** concentrate change risk:
   - `apps/agent/src/cli/main.ts` (1 156 lines);
   - `apps/agent/src/core/session-hub.ts` (985);
   - `packages/phone-core/src/realtime/realtime-client.ts` (812, one test file in its package; the PWA keeps its own tests).

   These are also v3 hotspots (`v3/PARALLEL.md` §3).
3. **There are two phone clients.** The PWA and the native app share `phone-core`, but the
   card rendering, key storage and push paths diverge. The native app has 7 test files,
   and its Swift targets have no CI coverage.
4. **Three roadmaps run in parallel** (main, v2, v3), each with its own ID space. Owner
   questions are spread across ROADMAP §6 (Q1–Q23), v2 (Q-P*) and v3 (Q-V3-*).
5. **Operations are code-ready but unproven:** the runbook, Sentry scrubbing and the
   backup plan exist, but none has been exercised against a live deployment.
