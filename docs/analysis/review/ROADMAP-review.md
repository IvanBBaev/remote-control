# As-built review — roadmap of follow-ups (2026-10-29)

Work items from the nine role reports (`reports/01…09`), de-duplicated and placed in three
phases. Findings, themes, owner questions and risks are in `SYNTHESIS.md`. The main
roadmap (`../ROADMAP.md` §4, section "RV") links here; status cells in this file change
only on `main`, like every other roadmap.

## How to execute
- **IDs** are the report IDs (`RV-<area>-NN`), so every row traces to its report. The
  report row holds the full scope, the files touched and the machine-checkable AC; this
  table does not repeat them.
- **Sizes:** S = 1 h, M = 2 h, L = 4 h of Opus 5.5.
- **Order:** phase A before phase B before phase C, except that a C item may run earlier
  when its lane is free and its deps are done. Inside a phase, follow the deps column.
- **Lanes:** a row with a lane touches paths owned by that v3 lane (`v3/PARALLEL.md` §2).
  Claim it like a v3 item of that lane, or wait until the lane is idle. `hotspot` means a
  PARALLEL §3 file (or one RV-ARC-01 adds there); `arch` is the pseudo-lane proposed in
  Q-ARC-1.
- **Done:** `pnpm check` green, commit `RV-XXX-NN: …` with an `AC:` line, then a separate
  commit that sets the status here to `done <sha>`.
- **Decisions:** D1–D25 and I1–I4 stay binding. Items that change a decision (RV-OPS-01,
  RV-AGT-05, RV-MOB-08) carry their ADR inside the item.

## Phase A — before the M1 owner day and the second-user run
Gate for M0-02b (deploy), M1-09b (first publish) and M1-14b (second user). These items fix
what a stranger or the first production deploy would hit.

| ID | Item | Source | Lane | Size | Deps | Status |
|---|---|---|---|---|---|---|
| RV-OPS-01 | Port Railway settings to `.railway/railway.ts` + ADR (Config as Code ends 2026-12-01) | 06 F1 | — | L | before M0-02b | done 6aa2e28 |
| RV-OPS-03 | Fix the admin command docs (`railway ssh`, `apps/relay` path) | 06 F3 | — | S | — | todo |
| RV-OPS-02 | Ordered day-one checklist (Q15 npm track, Q2 domain + Railway track) | 06 F2 | — | M | RV-OPS-03 | todo |
| RV-OPS-04 | Release `gate` job: tag on `main` + required checks green | 06 F4 | — | M | — | todo |
| RV-OPS-05 | Document APNs and spike variables; config-coverage test | 06 | — | S | — | todo |
| RV-OPS-06 | Expiry test for `auditConfig.ignoreGhsas` | 06 | — | S | — | todo |
| RV-OPS-07 | Placeholder publish kit + direct-to-main release checklist | 06 | — | S | — | todo |
| RV-OPS-08 | Runbook drift fixes | 06 | — | S | — | todo |
| RV-OPS-09 | Declare the optional SDK peer correctly | 06 | — | S | — | todo |
| RV-OPS-10 | npm version gate ≥ 11.5.1 | 06 | — | S | — | todo |
| RV-OPS-12 | Align `m0-exit.md` criterion 3 with ADR 0002 | 06 | — | S | — | todo |
| RV-RLY-01 | Production runs `RC_HUB=pg`; two-process overlap test | 02 F1 | — | M | ADR 0016; before M0-02b | done 23f5c6d |
| RV-RLY-02 | Expand/contract migration rule + CI guard | 02 | — | S | — | todo |
| RV-RLY-04 | WebSocket-path and push failures to Sentry | 02 F3 | — | S | M0-26b (DSN) | todo |
| RV-RLY-06 | Production push-config visibility (`/health` field) | 02 | — | S | — | todo |
| RV-RLY-07 | Shutdown hygiene (no `off` while draining, close APNs sender, README 503) | 02 | — | S | — | todo |
| RV-RLY-09 | Hygiene: generated request ids, `/api/state` limit, chunk bounds | 02 | — | S | — | todo |
| RV-SEC-01 | SECURITY.md accuracy pass (PWA trust row, native/SE, APNs, legacy peers, noble) | 01 F1, F3 | sec-cards | S | coordinate V3-S13 | todo |
| RV-SEC-02 | Security headers + CSP on every relay response incl. the PWA (absorbs RV-WEB-01) | 01 F2, 05 F1 | — | S | — | done 5617360 |
| RV-SEC-03 | Refuse keyless pairing unless `--allow-relay-trust`; warn on legacy peers | 01 F4 | — | S | — | done 2b1204d |
| RV-SEC-04 | Remove the readable-seed fallback in the PWA key store | 01 | — | S | — | done 4fdc777 |
| RV-SEC-05 | Assertion check verifies `clientDataJSON.origin` and `crossOrigin` | 01 | requester | S | V3-A03 if started | done 4a4ce66 |
| RV-SEC-06 | Refuse decisions with `issued_at` > now + 60 s | 01 | requester | S | V3-A03 if started | done 030ccf4 |
| RV-SEC-09 | Extend redaction keys and test them | 01 | — | S | — | todo |
| RV-AGT-01 | Hand off at once when no phone can answer (no 30-min silent hold) | 03 F1 | — | M | — | done dc1e4fa |
| RV-AGT-02 | Several pending requests per session | 03 F2 | — | M | Q-AGT-5 | todo |
| RV-AGT-03 | Unshowable request: immediate handoff, no doorbell | 03 | — | S | — | todo |
| RV-AGT-05 | Folder bound for follow-ups in plan-bound folders (+ ADR 0006 amendment) | 03 F5 | claude-surface | M | Q-AGT-3 | todo |
| RV-AGT-06 | Service carries the config-dir env; SDK key warning | 03 | — | S | — | todo |
| RV-AGT-07 | Detect version-manager Node and a missing hook `execPath` | 03 | claude-surface | S | — | todo |
| RV-AGT-08 | Agent-side relay heartbeat | 03 | — | S | — | todo |
| RV-AGT-10 | Spawn timeout for `--bg` and resume | 03 | claude-surface | S | — | todo |
| RV-AGT-12 | Prune settings backups to 3 | 03 | claude-surface | S | — | todo |
| RV-WEB-02 | Tell lost user activation from cancel; delayed-relay case in M0-03b | 05 F2 | — | M | M0-03b | todo |
| RV-WEB-03 | Live notification permission and per-wake `registerPush` | 05 | — | S | — | todo |
| RV-WEB-04 | `pushsubscriptionchange` handler + visible push-failed state | 05 F4 | — | M | RV-WEB-03 | todo |
| RV-WEB-05 | KK handshake deadline and retry | 05 F5 | — | S | — | todo |
| RV-WEB-06 | Dark-theme contrast tokens | 05 | sec-cards | S | — | todo |
| RV-WEB-07 | Announce errors; focus heading on route change | 05 | sec-cards | M | — | todo |
| RV-WEB-08 | Real `APP_VERSION` from package.json | 05 F8 | — | S | feeds V3-C12 | todo |
| RV-WEB-09 | Prompted service-worker update instead of unconditional `skipWaiting` | 05 F9 | — | M | RV-WEB-08 | todo |
| RV-WEB-10 | Backoff jitter and relay-time outbox expiry | 05 F10 | — | S | — | todo |
| RV-WEB-11 | State hygiene: `paired`, ack-after-decrypt, prune resolved views | 05 | — | S | — | todo |
| RV-UX-01 | Drop `npx` from every phone instruction | 09 F2 | — | S | — | todo |
| RV-UX-02 | `remotectl login --relay <url>` writes the relay URL | 09 F3 | hotspot | M | — | todo |
| RV-UX-03 | Phone shows the full login command with relay origin + Copy/Share | 09 | — | S | RV-UX-01, RV-UX-02 | todo |
| RV-UX-04 | Login success lists hooks, install, pair and self-test | 09 | — | S | RV-UX-02 | todo |
| RV-UX-05 | Quick start uses `login --relay`; status note covers the app | 09 | evidence | S | RV-UX-02 | todo |
| RV-UX-09 | Vocabulary alignment: computer / phone / session | 09 | — | S | Q-UX-3 | todo |
| RV-UX-11 | `pair` uses the enrolment name; `screens.md` and help drift | 09 | — | S | — | todo |
| RV-QA-05 | `fixtures:compare` drift check against a real CLI recording | 07 F3 | — | M | useful once M0-23b records | todo |
| RV-QA-06 | Condition-based waits, `crypto-noble` timeout, shared time scale (absorbs the web `testTimeout` part of RV-WEB-13) | 07 F4 | — | M | — | todo |
| RV-QA-07 | Fix the write that survives `runCli` abort; fail on unhandled errors | 07 | — | S | — | todo |
| RV-QA-08 | Encoding-aware leak search, HTTP/WS egress sources; J11 joins the gate | 07 F5 | — | M | — | todo |
| RV-QA-09 | One invariant map + a test that keeps it honest (absorbs RV-RLY-10, RV-AGT-11) | 07, 02, 03 | — | S | — | todo |
| RV-QA-11 | WebKit smoke sends a Deny and a question answer | 07 | — | S | — | todo |
| RV-QA-13 | e2e hygiene: private ports, relay health check, bounded SW loops, flaky report | 07 | — | S | — | todo |

## Phase B — before M4-08 (TestFlight)
Without these the native app cannot sign in on a release build, loses decisions after a
deploy, and has no CI on its Swift code. M4-08 gains a dependency on this phase.

| ID | Item | Source | Lane | Size | Deps | Status |
|---|---|---|---|---|---|---|
| RV-UX-06 | Native passkey sign-in and registration (invite, recovery code), associated domain + AASA, re-auth on 401 (absorbs RV-MOB-05 sign-in) | 09 F1, 04 | — | L | Q2, Q22, Q-UX-1 / Q-MOB-1 | todo |
| RV-UX-07 | Native enrol-a-computer, QR pair, revoke phone, in-app account deletion (absorbs RV-MOB-05 deletion) | 09 F1, 04 | — | M | RV-UX-06, RV-UX-03 | todo |
| RV-UX-08 | Native release hygiene: no sample data, no WP ids, real Face ID state, mapped errors | 09 | — | S | RV-UX-06 | todo |
| RV-UX-10 | Privacy policy page on the production domain | 09 | — | S | Q2, Q-UX-5 | todo |
| RV-MOB-01 | Wake realtime on foreground; retry a failed connect | 04 | — | S | — | todo |
| RV-MOB-02 | Intent TTL follows request expiry; tell the user when Allow/Deny was not sent | 04 | — | S | RV-MOB-01 | todo |
| RV-MOB-03 | Detect an invalidated device key (Face ID change), delete, re-key on re-pair | 04 | — | M | — | todo |
| RV-MOB-04 | "Disconnect" becomes "Sign out": wipe identity, pairings, NSE keys, device key, APNs token | 04 | — | M | RV-MOB-03 | todo |
| RV-MOB-06 | Generic push uses a review-only category; NSE upgrades to `rc.pending` after decryption | 04 | sec-cards | S | Q-MOB-2 | todo |
| RV-MOB-07 | APNs environment follows the build profile, not `__DEV__` | 04 | — | S | Q-MOB-6 | todo |
| RV-RLY-03 | APNs: log the rejection reason, retry the other environment on BadDeviceToken | 02 F2 | — | M | M4-05 | todo |
| RV-RLY-05 | Push budget spent only on a final result; one bounded retry | 02 | — | S | RV-RLY-03 | todo |
| RV-MOB-08 | ADR 0017 amendment: Live Activity buttons under D23; M4-06 prerequisites | 04 | — | S | Q-MOB-4; before M4-06 | todo |
| RV-MOB-09 | macOS CI job: prebuild, compile all targets, Swift tests on shared TS↔Swift vectors | 04 | sec-cards | L | — | todo |
| RV-MOB-10 | Correct the native verification record; physical-device checklist for M4-08 | 04 | — | S | — | todo |
| RV-MOB-11 | Honesty fixes: time-sensitive entitlement, iOS floor, live Face ID row, key-less pairing | 04 | — | S | Q-MOB-5 | todo |
| RV-SEC-07 | Noise vectors, handshake, pairing, push-summary tests on both backends | 01 F5 | — | S | — | todo |
| RV-SEC-08 | Lock the crypto backend after selection | 01 | — | S | — | todo |
| RV-QA-01 | Police `coverage.exclude` with a justified allow-list | 07 F1 | — | S | — | todo |
| RV-QA-02 | Unit-test mobile adapters and state with native modules mocked | 07 F1 | — | M | RV-QA-01 | todo |
| RV-QA-03 | Golden Secure Enclave ES256 fixture verified by the agent | 07 F2 | requester | S | owner simulator run | todo |
| RV-QA-04 | Harness journey: device-key Allow through mobile `authorize` on noble | 07 F2 | — | M | RV-QA-03 | todo |

## Phase C — hardening and modularity, sequenced against the v3 lanes
Not release blockers. RV-ARC-01 should land first, because it changes the lane rules
every parallel session reads. The rest follows the collision-free order in
`reports/08-architecture.md` §5.

| ID | Item | Source | Lane | Size | Deps | Status |
|---|---|---|---|---|---|---|
| RV-ARC-01 | Missing hotspots in PARALLEL §3; re-scope version-gate to the real handshake sites | 08 F1, F2 | version-gate | S | Q-ARC-2 | todo |
| RV-ARC-06 | eslint layering and cross-app blocks with fixture tests | 08 F3 | rules | M | Q-ARC-4 | todo |
| RV-ARC-12 | Break the `main.tsx` ↔ `split.tsx` cycle | 08 | — | S | — | todo |
| RV-ARC-07 | `tools/check-cycles.mjs` wired into lint | 08 | — | S | RV-ARC-12 | todo |
| RV-ARC-14 | Break the type-only cycle `pending-store` ↔ `ports/agent-adapter` | 08 | — | S | — | todo |
| RV-ARC-11 | `@simplewebauthn/browser` to devDependencies in phone-core | 08 | hotspot | S | — | todo |
| RV-ARC-04 | Exhaustive handler table instead of the `apply()` switch | 08 | arch | M | RV-ARC-01 | todo |
| RV-ARC-02 | Extract the daemon graph from `runCommand` (`core/agent-runtime.ts`, `cli/run.ts`) | 08 | arch | L | RV-ARC-01; no evidence/requester/rules item `doing` | todo |
| RV-ARC-03 | Command bodies into `cli/<command>.ts`; per-command help | 08 | arch | M | RV-ARC-02 | todo |
| RV-ARC-05 | Split `session-hub.ts` into `core/session-hub/` | 08 | arch | L | V3-A03 done | todo |
| RV-ARC-08 | `device-session.ts`, `hub-wire.ts`; rename `notify-hub.ts` | 08 | — | M | before V3-C12 claimed, or after V3-C13 | todo |
| RV-ARC-09 | phone-core exports map; phone-core tests into the package; drop web shims (absorbs RV-WEB-13 test move) | 08, 05 | sec-cards | L | after V3-S13; Q-ARC-3 | todo |
| RV-ARC-10 | test-harness phone reuses phone-core pairing and uuid | 08 | — | M | RV-ARC-09 | todo |
| RV-ARC-13 | `seededRandom` and one fake clock into test-harness | 08 | — | M | RV-ARC-10 | todo |
| RV-RLY-08 | Rate-limit failed WebSocket upgrades per IP; atomic device-cap check | 02 | version-gate | S | V3-C12 | todo |
| RV-AGT-04 | Separate short Gemini hold | 03 | claude-surface | S | Q-AGT-2 | todo |
| RV-AGT-09 | Windows: resolve `claude.exe`, report `claude_not_spawnable` | 03 | claude-surface | S | M0-25 real Windows run | todo |
| RV-WEB-12 | Bundle budget in `check-build.mjs` | 05 | — | S | — | todo |
| RV-OPS-11 | Image reproducibility and context trimming | 06 | — | S | — | todo |
| RV-QA-10 | Harness relay boots through `apps/relay/src/container.ts` | 07 F7 | hotspot | L | — | todo |
| RV-QA-12 | Windows key-file ACL test; J8 and J12 on the OS matrix | 07 | version-gate | M | — | todo |
| RV-QA-14 | Soak smoke gates on duplicates and leaks; `simple-webauthn.ts` branch tests | 07 | version-gate | S | — | todo |

## Merged items (no own work)
| ID | Merged into | Why |
|---|---|---|
| RV-WEB-01 | RV-SEC-02 | Same headers and CSP on the same relay responses. |
| RV-MOB-05 | RV-UX-06 + RV-UX-07 | Same native sign-in, re-auth and account deletion; UX splits it in two. |
| RV-RLY-10 | RV-QA-09 | Invariant numbering; 00-state is already fixed, the code comments and map remain. |
| RV-AGT-11 | RV-QA-09 | Same as RV-RLY-10. |
| RV-WEB-13 | RV-ARC-09 + RV-QA-06 | Test move is in ARC-09; the web `testTimeout` is in QA-06. |

## Totals
| Phase | Items | Hours |
|---|---|---|
| A — before M1 owner day / second user | 57 | 74 |
| B — before M4-08 TestFlight | 22 | 34 |
| C — hardening and modularity | 22 | 41 |
| **All** | **101** | **149** |

106 report items; 5 are merged into others, which leaves 101 active items. To recompute,
sum the size column (S = 1, M = 2, L = 4) of the `| RV-` rows in each phase table.
