# 08 — TypeScript / monorepo architecture review (as-built, main @ f0281ef)

Role 08, area code ARC. Scope: pnpm workspace, tsconfig project references and the `tsc -b`
graph, tsdown builds, package boundaries and exports maps, dependency direction, file sizes,
duplication between web / mobile / phone-core, `container.ts` wiring, eslint boundary rules,
circular dependencies, and v3 lane collision safety for split proposals.

## 1. Summary

- **Verdict, M1 release: ready-with-fixes.** The build graph is sound: `tsc -b` exits 0 over 29
  projects. Dependency direction is clean in non-test code, and no finding blocks shipping.
- **Verdict, native-app TestFlight: ready-with-fixes.** phone-core is shared correctly through
  ports. However, its tests live in `apps/web`, and its exports map is a wildcard, so the RN path
  has almost no package-local coverage or API boundary.
- The real risk is **parallel v3 work, not shipped code**. Four de-facto hotspots are not in
  PARALLEL §3 (`session-hub.ts`, `realtime-client.ts` `apply()`, `cli/main.ts` `runCommand`
  and `HELP_TEXT`). The version-gate lane also owns a directory (`apps/relay/src/ws/**`) where
  the handshake does not live.
- Layering (D2, ROADMAP §5) holds today by convention only. No lint rule enforces it.
- Findings: 0 critical, 2 high, 4 medium, 4 low. Work items: 14 (about 29 h).

## 2. Verified facts

V1. **The typecheck graph is green.**
- `node_modules/.bin/tsc -b` exits 0.
- `tsc -b --verbose --dry` lists 29 projects; the root `tsconfig.json` references 12.
- Wall time was 8:05, but CPU was only 26 s user (8%), because other reviewers ran
  concurrently. This is not a graph problem.

V2. **Root gate.** `package.json` defines
`check = typecheck && lint && format:check && test && build`, with `typecheck = tsc -b`.
`pnpm-workspace.yaml` covers `apps/*`, `packages/*` and `e2e`, sets
`minimumReleaseAge: 10080`, and has one override (`@xmldom/xmldom`).

V3. **Every workspace package exports TypeScript source** (`"." -> ./src/index.ts`):
- protocol, crypto (`.`, `./noble`), log, fake-claude-code and test-harness.
- relay adds `./testing`.
- agent (`remotectl`) adds `./hook`, and its `publishConfig.exports` exposes only
  `./package.json`.
- **phone-core: `"./*": "./src/*.ts"`**. Every file is public.

V4. **phone-core dependencies.**
- `@simplewebauthn/browser` is a runtime dependency, but it is imported type-only
  (`packages/phone-core/src/auth/relay-api.ts:1-6`).
- `zustand/vanilla` is imported at runtime (`realtime/realtime-store.ts:12`, `usage-stats.ts:1`).

V5. **Builds.**
- The agent build runs `scripts/check-argv-policy.mjs` before tsdown, and bundles all
  `@remote-control/*` packages from devDependencies.
- The relay's `tsdown.config.ts` uses `alwaysBundle: [/^@remote-control\//]` and
  `neverBundle: true`.
- The Dockerfile uses `pnpm --filter relay deploy --prod --legacy` and copies the web `dist`
  into `public`.

V6. **tsconfig coupling.**
- `apps/agent/tsconfig.json` references `packages/fake-claude-code`, because `src` includes
  `*.test.ts`.
- `seededRandom` (a test fake for the `Random` port) lives in `@remote-control/fake-claude-code`
  and is imported by about 10 agent tests.
- `packages/test-harness` references `apps/relay` and `apps/agent`.
- The `apps/web` harness project references `../relay`.

V7. **Lint guards contain no boundary rule.** `eslint.config.mjs` has:
- `no-restricted-properties` for `Date.now`, `Math.random` and `crypto.getRandomValues`;
- `no-restricted-imports` for `node:crypto`, `crypto` and `@noble/*`.

There is no core→adapters rule, no cross-app import ban, no `import/no-cycle` and no
`max-lines`. `tools/lint-rules.test.ts` covers only the guards above. The only structural
script gate is `apps/agent/scripts/check-argv-policy.mjs` (D13).

V8. **Dependency direction is clean in non-test code.**
- `grep -rn "from '\.\./\(adapters\|cli\|http\|ws\|db\)" apps/{agent,relay}/src/core --include='*.ts' | grep -v test`
  returns 0 hits.
- The only third-party import in relay core is `import type { Logger } from 'pino'`, in
  pg-notify-hub, revocation-service, relay-router, audit-recorder and push-notifier.
- Ports import types from core:
  - `apps/agent/src/ports/agent-adapter.ts:3` (`PendingRequest` from `core/pending-store`)
  - `apps/agent/src/ports/claude-cli.ts:3`
  - `apps/relay/src/ports/relay-seams.ts:3`
  - `apps/relay/src/ports/database-health.ts:1`

V9. **Cross-app imports appear only in tests, test-harness and `e2e/server.ts`.** For example,
`apps/web/src/realtime/pairing.harness.test.ts:4` imports `SoftwareAuthenticator` from
`@remote-control/relay/testing`.

V10. **Cycles.** A scratch script (`scratchpad/arc/cycles.py`) parsed 439 modules: 857 runtime
edges, or 1431 including `import type`.
- **One runtime cycle:** `apps/web/src/screens/split.tsx:5` imports `SessionList` from
  `./main.js`, and `apps/web/src/screens/main.tsx:16` imports `useWideLayout` from
  `./split.js`.
- **Three type-only cycles:**
  - `packages/crypto/src/backend.ts` ↔ `backends/web-crypto.ts`
  - `packages/protocol/src/messages.ts` ↔ `session-feed.ts`
  - `apps/agent/src/core/pending-store.ts` ↔ `ports/agent-adapter.ts`

V11. **Non-test files over 400 lines** (`wc -l`, excluding `*.test.ts`, `dist`, `node_modules`):

| File | Lines | Shape |
|---|---|---|
| `apps/agent/src/cli/main.ts` | 1156 | `HELP_TEXT` 78–110; `COMMANDS` 123–136; `runCli` 139; **`runCommand` 221–520 is the daemon composition root**; status 521; selfTest 600–676; pause/resume 740–770; login 796; pair 842; devices/revoke 890–955; hooks 956–1080; logs 1089; install/uninstall/update 1143–1156 |
| `apps/agent/src/core/session-hub.ts` | 985 | one closure `createSessionHub` (219–985). Transport helpers 242–387, snapshot/views 388–490, handshake 491–564, reply 565, verify 591–640, command 641–751, launch 752–851, registry events 852–909, public object 910–985 |
| `packages/phone-core/src/realtime/realtime-client.ts` | 812 | closure 180–812. Socket 193–268, control/handshake 269–356, frame handlers 357–464, **`apply()` 465–577, a 16-case switch on `message.t`**, diff/flush/poll 578–673 |
| `apps/relay/src/core/pg-notify-hub.ts` | 576 | wire `Message` zod schema and chunking constants 19–95; the class from 112 sits on the `NotifyBus` port, so "pg" in the name is wrong |
| `apps/relay/src/core/relay-router.ts` | 570 | `RelayRouter` 84–318 plus the unexported `class DeviceSession` 319–570; `#hello` 474–540 calls `negotiateVersion` at 480 |
| `packages/test-harness/src/phone.ts` | 558 | `createPhone` 197; its own `CROCKFORD` (50), `pairingSecrets` (166–176), `uuidV7` (180) |
| `packages/phone-core/src/realtime/phone.ts` | 499 | `createPhoneService` 218 |
| `apps/agent/src/core/hooks-installer.ts` | 450 | Claude, Codex and Gemini hook specs in one file (claude-surface lane) |
| `apps/web/src/screens/main.tsx` | 444 | several screens plus `SessionList` |

V12. **Container wiring.**
- `apps/agent/src/container.ts` (281 lines) builds a **port bag**: clock, fs, stores and
  adapters.
- The application object graph is assembled in `cli/main.ts` `runCommand`. It calls:
  - `createPendingStore` (262)
  - `createHookDispatcher` (331)
  - `createRelayLink` (404)
  - `createActivityTracker`, `createPauseWatch`, `createSdkClaudeCli`,
    `createSessionRegistry`, `createSessionFeed`, `createHookSeenTracker`, `createDiffStore`,
    `createPairingLock` and `createLauncher`
- `cli/main.ts:1-62` imports adapters directly: file-hook-seen-store, file-pause-store,
  file-stats-store, claude-sdk, codex and gemini.
- `apps/relay/src/container.ts` is 238 lines and is the real composition root.

V13. **Duplication** (scratch `dup.py`, 8-line normalised windows):

| Pair | Shared windows |
|---|---|
| `apps/agent/src/testing/fake-phone.ts` ↔ `packages/test-harness/src/phone.ts` | 22 |
| codex ↔ gemini adapter | 17 |
| `apps/mobile/src/adapters/relay-transport.ts` ↔ `apps/web/src/adapters/browser-socket.ts` | 7 |
| `apps/relay/src/testing/fake-time.ts` ↔ `packages/test-harness/src/fake-clock.ts` (plus `apps/web` `test-timer.ts`) | 7, 2, 2 |
| web `approval.tsx` ↔ `question.tsx` (sec-cards lane) | 4 |
| agent ↔ phone-core `usage-stats` | 2 |
| agent ↔ relay `system-timer` | 2 |

V14. **Pairing derivation exists three times**, with the same HKDF labels and Crockford
alphabet.
- `packages/phone-core/src/pairing/pairing-code.ts:5,45,50`
- `apps/agent/src/core/pairing-code.ts:8,11,12`
- `packages/test-harness/src/phone.ts:50,175,176`

`apps/relay/src/core/crockford-base32.ts:1` has a fourth copy of the alphabet. The agent and
phone copies are legitimate (opposite peers, D6). The test-harness copy should reuse
phone-core.

V15. **Four headless-phone implementations:**
- phone-core `realtime/phone.ts` plus `realtime-client.ts` (production)
- `packages/test-harness/src/phone.ts`
- `apps/agent/src/testing/fake-phone.ts` (388 lines)
- `apps/web/src/realtime/test-phone.ts`

V16. **apps/web shim layer (M4-03 / ADR 0017).**
- 10 files in `apps/web/src` are two-line `export *` re-exports of phone-core:
  - `realtime/{envelope,realtime-store,relay-socket,usage-stats}`
  - `auth/{relay-api,passkey-keys}`
  - `pairing/{pairing-code,qr-text}`
  - `ports/timer`
- `realtime/realtime-client.ts` (34 lines) and `realtime/phone.ts` (22 lines) are thin binders.
- phone-core's behavioural tests stay in web: `realtime-client.test.ts` is 1084 lines and
  `phone.test.ts` 821.
- `packages/phone-core` has **1** test file (`card-safety`).
- The web `pairing/key-store.ts` (IndexedDB) and mobile `adapters/secure-key-store.ts`
  correctly implement the phone-core `KeyStore` port. That is not duplication.

V17. **PARALLEL.md §3 hotspot list** (`docs/analysis/v3/PARALLEL.md:43-54`) covers:
- `messages.ts` / `index.ts`
- `cli/main.ts` ("dispatch branch ≤ 3 lines; body in `cli/<command>.ts`")
- `container.ts` (one block per lane)
- `parse-config`, drizzle, the lockfile, ADRs, the v3 ROADMAP, SECURITY, README and `ci.yml`

It does **not** list `session-hub.ts`, `realtime-client.ts` or `relay-router.ts`.
- The version-gate lane owns `negotiate-version.ts`, `upgrade-required.ts` and
  "`apps/relay/src/ws/**` handshake", and must not touch "agent core".
- `apps/relay/src/ws/` contains only `ws-route.ts` and its test.

## 3. Assumptions

- A1. Lane plans are inferred from the ROADMAP-v3 item titles:
  - V3-S02 rules, V3-A04 requester and V3-P02 stats need daemon wiring.
  - Elicitation, rule and requester messages add protocol `t` values.

  I did not read unwritten lane designs.
- A2. Metro and the Expo tsconfig resolve phone-core's `./*` wildcard. Changing it to an explicit
  map was not tried, because running Metro or a simulator is out of scope.
- A3. The 8-minute `tsc -b` wall time came from CPU contention (8% CPU). A solo timing was not
  possible during the parallel review.
- A4. The cycle and duplication scripts are regex-based. Dynamic `import()` and re-export chains
  through `export *` may be under-counted.

## 4. Findings

### F1 — high — Unlisted de-facto hotspots, and a `cli/main.ts` rule that cannot hold for daemon wiring
**Evidence**
- PARALLEL §3 (`docs/analysis/v3/PARALLEL.md:43-54`) treats `cli/main.ts` as a dispatch file
  with ≤ 3 lines per command.
- In reality, `apps/agent/src/cli/main.ts:221-520` (`runCommand`) is the daemon composition
  root (V12). Wiring a rules engine (V3-S02), requester socket (V3-A04 / V3-S05) or stats
  counter (V3-P02) into the dispatcher and relay link means editing that 300-line body, plus
  `HELP_TEXT` (78–110) and the import block (1–62).
- `apps/agent/src/core/session-hub.ts` will be touched by:
  - rules (phone-side rule messages),
  - requester (verify imports at 591–640 move to `@remote-control/decision-verify`, P2),
  - claude-surface (elicitation and command at 641–751).
- `packages/phone-core/src/realtime/realtime-client.ts:465-577` `apply()` gains a case for
  **every** new `t` value, from at least version-gate, rules, requester and claude-surface.
- None of these files is owned by a lane, and none is in §3.

**Why it matters**
- Several lanes will edit the same 300–900-line closures and switch, while the protocol rule says
  "append-only, keep both sides" only for `messages.ts`.
- Merge conflicts inside a closure resolve silently wrong far more easily than in an append-only
  list. A dropped `case` in `apply()` means a phone silently ignores a message type.

**Touches:** R19 (executor context: one-file edits of 985 lines), V3 sync points P2 and P3, D2.

### F2 — high — Version-gate ownership does not match where the handshake lives
**Evidence**
- The version-gate lane owns "`apps/relay/src/ws/**` handshake". That directory holds only
  `ws-route.ts`.
- The relay handshake is `DeviceSession.#hello` in `apps/relay/src/core/relay-router.ts:474-540`,
  which calls `negotiateVersion` at :480.
- The agent hello is in `apps/agent/src/core/relay-client.ts:159-161`. That is agent core, which
  the lane "must not touch".
- The phone hello is in `realtime-client.ts:269-356`, which no lane owns.

**Why it matters**
- V3-C12 cannot be done inside its declared paths.
- The executor will either break the lane rule or put `upgrade_required` handling in the wrong
  layer, for example in `ws-route.ts`, before the session exists.
- P3 makes C12 a blocker for every lane that adds a `t` value, so the mis-scoping blocks the
  whole wave.

**Touches:** V3-C12 / C13, P3, D2 (the handshake belongs in core).

### F3 — medium — Layering (D2, ROADMAP §5) is not machine-enforced
**Evidence**
- V7: no boundary, cross-app or cycle rule exists. V8 shows the direction is clean today.
- ROADMAP §5 states "`src/core` never imports Fastify, `ws`, `pg`, React or `node:*` beyond
  types", but no gate checks it. The only structural gate is the argv policy (D13).

**Why it matters**
- Nine lanes will add modules in parallel, with executors that read only their WP scope (R19).
- One `import { … } from '../adapters/…'` in core, or `apps/web` importing `apps/relay`
  outside a test, passes `pnpm check` today.
- The cost of fixing it later grows with every lane merge.

**Touches:** D2, ROADMAP §5 conventions, R19.

### F4 — medium — phone-core has no public API, and its tests live in another app
**Evidence**
- V3: `packages/phone-core/package.json` exports `"./*": "./src/*.ts"`.
- V16: 10 two-line `export *` shims in `apps/web`, with 1905 lines of phone-core behaviour tests
  in `apps/web/src/realtime/*.test.ts`. phone-core itself has 1 test file.

**Why it matters**
- `apps/mobile` can (and will) deep-import internals, so the boundary that ADR 0017 created is
  not enforced.
- A change in phone-core is tested only when the web vitest project runs. A mobile-only consumer
  (TestFlight build) has no package-local proof of the noble crypto path, because the web tests
  bind the WebCrypto backend.
- The shims double the edit surface for every lane that touches realtime: two files per module.

**Touches:** ADR 0017 / M4-03, the native-app TestFlight readiness.

### F5 — medium — Four phone implementations and a third pairing derivation drift independently
**Evidence**
- V14 and V15. `packages/test-harness/src/phone.ts:166-180` re-implements `pairingSecrets`,
  `CROCKFORD` and `uuidV7` instead of importing phone-core.
- `apps/agent/src/testing/fake-phone.ts` shares 22 eight-line windows with it.
- There are three fake clocks (V13).

**Why it matters**
- The e2e and harness tests prove agent ↔ *test-harness phone* compatibility, not agent ↔
  *phone-core*.
- A protocol change made in phone-core but mirrored wrongly in a test phone (or the reverse)
  stays green. That is exactly the skew V3-C13 is meant to catch, but it would be caught too
  late.
- I3 (the relay never learns the code) depends on the slot derivation. Three copies of it mean
  three places to get it wrong.

**Touches:** I3, D6, R10, V3-C13.

### F6 — medium — God-closures in the two busiest runtime modules
**Evidence**
- `session-hub.ts`: one 766-line closure.
- `realtime-client.ts`: a 632-line closure with a 112-line switch (V11).
- All inner functions share mutable closure state, so neither can be unit-tested in parts. The
  web test for it is 1084 lines.

**Why it matters**
- These are the two files every v3 lane edits (F1), and the files an executor must hold whole in
  context (R19).
- Splitting them is the structural fix for F1. Sequencing is in §5.

**Touches:** R19, ROADMAP §5 "one exported thing per module in core" (met in letter only).

### F7 — low — Runtime import cycle `main.tsx` ↔ `split.tsx`
**Evidence**
- `apps/web/src/screens/split.tsx:5` and `main.tsx:16` (V10).
- ES modules tolerate it today, because both bindings are used only at render time.

**Why it matters:** A top-level use (for example a `const` derived from `SessionList`) would
crash with a TDZ error at load time.

**Touches:** none of I1–I4. Hygiene.

### F8 — low — phone-core declares a type-only package as a runtime dependency
**Evidence:** V4. `@simplewebauthn/browser` is a runtime dependency, but phone-core uses it only
in `import type` (`relay-api.ts:1-6`).

**Why it matters**
- `apps/mobile` installs a browser WebAuthn library into the RN dependency tree for nothing.
- It widens the supply-chain surface (R13 spirit) and causes Metro resolution noise.

**Touches:** R13 (extends it to the phone bundle).

### F9 — low — Relay core files mix concerns and naming
**Evidence**
- `relay-router.ts` holds two classes (84–318 and 319–570).
- `pg-notify-hub.ts:19-95` embeds the wire codec, and the class sits on the `NotifyBus` port,
  not on pg.

**Why it matters:** The misnamed file makes the hexagon look violated (`pg` in core) to every
reviewer and executor. The two-class file makes F2's handshake hard to find.

**Touches:** D2 (readability of the layering).

### F10 — low — Production typecheck is coupled to test fakes
**Evidence**
- V6: `apps/agent/tsconfig.json` references fake-claude-code only because of tests.
- `seededRandom`, a generic `Random` fake, lives in a package named for faking Claude Code.

**Why it matters**
- Any fake-claude-code change rebuilds the agent project.
- Test utilities are found by accident, not by name.

**Touches:** none. Build hygiene.

**Not raised (already covered elsewhere):**
- codex/gemini adapter duplication (17 windows): V2-AG-03, the adapter port split.
- `approval.tsx` / `question.tsx` duplication: sec-cards lane, V3-S03 follow-ups.
- `hooks-installer.ts` (450 lines): claude-surface lane. A per-agent spec split belongs inside
  V3-A06 / V3-S09 scope, and I do not propose it here.

## 5. Recommendations

**R-A. Fix the lane map before wave 2 (F1, F2). Doc-only, on `main`, as a claim-style commit.**
1. Add to PARALLEL §3:
   - `session-hub.ts`: append-only handler entries after RV-ARC-05.
   - `realtime-client.ts` / `apply-message.ts`: append-only entries in the handler table.
   - `cli/main.ts` `HELP_TEXT`: one line per command, appended.
   - The new `core/agent-runtime.ts`: one wiring block per lane, like `container.ts`.
2. Re-scope version-gate ownership to:
   - `apps/relay/src/core/device-session.ts` (after RV-ARC-08), or `relay-router.ts`
     `#hello` while C12 is `doing`;
   - `apps/agent/src/core/relay-client.ts` hello (lines 150–175);
   - the phone-core handshake module.

   Record the exception to "must not touch agent core" in that row.
- *Rejected:* letting the executor discover the mismatch. P3 makes C12 a wave blocker, and an
  executor told to "stay inside your lane" will put the gate in `ws-route.ts`, which is the wrong
  layer.

**R-B. Move the daemon composition root out of `cli/main.ts` first (F1, F6).**
- Extract `runCommand` 221–520 into:
  - `apps/agent/src/core/agent-runtime.ts`: a pure graph builder that takes the `Container`;
  - `apps/agent/src/cli/run.ts`: the thin command.
- Move each remaining command body into `cli/<command>.ts`, as §3 already demands for new
  commands.
- Make `HELP_TEXT` a list assembled from per-command `help` fields.
- Sequencing:
  - Do it as one RV item while **no** evidence, requester or rules item is `doing`. All three
    will wire into `runCommand`. Today all three are `todo` or gated.
  - Hold the lock as a pseudo-lane `arch`, claimed on `main` like any lane.
- *Rejected:* moving wiring into `container.ts`. It is a port bag, and §3 already makes it
  append-only, so adding a second graph to it would merge two concerns.

**R-C. Split `realtime-client.ts` `apply()` into a handler table before V3-C12 merges (F1, F6).**
- `packages/phone-core/src/realtime/apply-message.ts` exports
  `Record<AgentMessage['t'], (ctx, msg) => void>`, typed with `satisfies`.
- An exhaustiveness check then makes a missing `t` a **type error**, and each lane appends one
  key.
- Sequencing:
  - It must land before P3 opens: after V3-C12 is claimed (so version-gate can depend on it) and
    before any rules, requester or claude-surface item adds a `t`.
  - The file is unowned. sec-cards owns only `card-safety/**` and mobile inbox files, so there is
    no collision with the active sec-cards lane.
- *Rejected:* a full class rewrite. That is too large to land between lanes.

**R-D. Split `session-hub.ts` after V3-A03 merges (F1, F6).**
Target layout, `apps/agent/src/core/session-hub/`:
- `transport.ts`: send* and serialize, 242–387
- `views.ts`: snapshot and shownRequests, 388–490
- `handshake.ts`: 491–564
- `decisions.ts`: reply and verify, 565–640
- `commands.ts`: command and launch, 641–851
- `index.ts`: the composing closure

Shared state is passed as one `HubState` object.
- Sequencing:
  - After V3-A03 is `done`, because it rewrites verify imports (P2).
  - While no rules (V3-S02) or claude-surface item that touches session commands is `doing`.
  - One commit, mechanical moves only, with the existing session-hub tests unchanged as the AC.
- *Rejected:* splitting now. It would collide with the requester lane's A03 verify extraction.

**R-E. Enforce the boundaries in lint (F3, F7).**
- Add flat-config blocks:
  - `files: ['apps/*/src/core/**']` with `no-restricted-imports` patterns for `**/adapters/**`,
    `**/cli/**`, `**/http/**`, `**/ws/**`, `fastify`, `ws`, `pg`, `drizzle-orm`, `react` and
    `node:*` (with `allowTypeImports: true`);
  - `files: ['apps/*/src/**']`, excluding tests, banning the other apps' package names and
    `@remote-control/test-harness` / `fake-claude-code`.
- Add a ~60-line `tools/check-cycles.mjs`, modelled on the argv-policy script, that fails on any
  runtime cycle. Wire it into `lint`.
- Extend `tools/lint-rules.test.ts` with one failing fixture per rule.
- *Rejected:* `eslint-plugin-import` or `madge`. Both are new devDependencies under the 7-day
  release-age policy, and the import plugin is slow on TS 6 project references. A local script
  matches the existing argv-policy pattern.

**R-F. Make phone-core a real package (F4, F8).**
1. Replace `"./*"` with an explicit exports map:
   `.`, `./realtime`, `./pairing`, `./auth`, `./card-safety`, `./ports`.
2. Move the phone-core tests from `apps/web/src/realtime/*.test.ts` into `packages/phone-core`.
   Add a noble-backend variant of the handshake test.
3. Delete the 10 web shims and point the web imports at the package.
4. Move `@simplewebauthn/browser` to `devDependencies` (type-only), or to `peerDependencies`
   marked optional.

- Sequencing: the test move touches files a sec-cards follow-up may touch, so do it after
  V3-S13 or between sec-cards items.
- *Rejected:* keeping the shims as a facade. They are pure `export *` and add nothing.

**R-G. Collapse test phones onto phone-core (F5, F10).**
- `packages/test-harness/src/phone.ts` imports `pairingSecrets` and `uuidV7` from phone-core
  and deletes its own copies.
- `apps/agent/src/testing/fake-phone.ts` either imports the shared helpers from test-harness or
  documents why it must stay protocol-naive.
- Move `seededRandom` and one fake clock into `packages/test-harness`. Drop the
  agent → fake-claude-code tsconfig reference where it was needed only for `seededRandom`.
- *Rejected:* replacing the test-harness phone with phone-core itself. The harness phone must be
  able to send malformed and adversarial frames, which the product client cannot.

**R-H. Small relay hygiene (F9).**
- Move `DeviceSession` to `core/device-session.ts`.
- Move the wire codec to `core/hub-wire.ts`, and rename `pg-notify-hub.ts` to
  `notify-hub.ts`.
- Sequencing: do it **before** V3-C12 is claimed, so version-gate owns a small file, or after
  V3-C13. Never during.

**R-I. Fix the `main.tsx` ↔ `split.tsx` cycle (F7).** Move `useWideLayout` to
`apps/web/src/screens/use-wide-layout.ts`. This is unowned and safe at any time.

## 6. Risks (new)

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| RV-ARC-R1 | Silent merge loss in the `apply()` switch or `session-hub` closures when two lanes merge, so a message type is dropped with no test failure (extends R19) | medium | high | RV-ARC-04 exhaustive handler table; RV-ARC-01 hotspot rules |
| RV-ARC-R2 | Version-gate implemented in `ws-route.ts` because of lane scoping, so the gate runs before session identity and logs version data on unauthenticated sockets | medium | medium | RV-ARC-01 re-scope |
| RV-ARC-R3 | The test phone diverges from phone-core, so skew bugs reach TestFlight users while e2e stays green (extends V3-C13 intent) | medium | high | RV-ARC-10; phone-core package tests (RV-ARC-09) |
| RV-ARC-R4 | A core→adapter or cross-app import lands in a parallel lane and hardens before review (erodes D2) | medium | medium | RV-ARC-06 / 07 lint gates |

## 7. Work items

The `arch` pseudo-lane is claimed on `main` per PARALLEL §1 when an item touches an unowned
hotspot.

| ID | Title | Size | Deps | Files touched | Acceptance criteria | Finding |
|---|---|---|---|---|---|---|
| RV-ARC-01 | Add the missing hotspots to PARALLEL §3 and re-scope version-gate ownership to the real handshake sites | S | — | `docs/analysis/v3/PARALLEL.md` | `grep -c "session-hub\|realtime-client\|agent-runtime\|relay-client.ts" docs/analysis/v3/PARALLEL.md` ≥ 4; the version-gate row names `relay-router.ts` or `device-session.ts` | F1, F2 |
| RV-ARC-02 | Extract the daemon graph from `runCommand` into `core/agent-runtime.ts` plus `cli/run.ts` | L | RV-ARC-01; no evidence, requester or rules item `doing` | `apps/agent/src/cli/main.ts` (hotspot), new `cli/run.ts`, new `core/agent-runtime.ts` | `pnpm --filter remotectl exec vitest run` green; `grep -c "from '../adapters/" apps/agent/src/cli/main.ts` = 0; `wc -l apps/agent/src/cli/main.ts` < 700 | F1, F6 |
| RV-ARC-03 | Move the remaining command bodies into `cli/<command>.ts`; per-command `help` | M | RV-ARC-02 | `apps/agent/src/cli/main.ts`, new `cli/{status,self-test,pause,login,pair,devices,hooks,logs}.ts` | `wc -l apps/agent/src/cli/main.ts` < 250; `remotectl --help` output byte-identical (snapshot test `help text is unchanged`) | F1 |
| RV-ARC-04 | Replace the `apply()` switch with an exhaustive handler table | M | RV-ARC-01; before any non-C12 item adds a `t` (P3) | `packages/phone-core/src/realtime/realtime-client.ts`, new `realtime/apply-message.ts` | `tsc -b` exits 0; a type test `apply-message.test-d.ts` fails if a key is removed; `wc -l realtime-client.ts` < 700; web `realtime-client.test.ts` green | F1, F6 |
| RV-ARC-05 | Split `session-hub.ts` into a `core/session-hub/` directory (mechanical) | L | V3-A03 done (P2); no rules or claude-surface item touching commands `doing` | `apps/agent/src/core/session-hub.ts` → `core/session-hub/{index,transport,views,handshake,decisions,commands}.ts` | Existing `session-hub*.test.ts` unchanged and green; no file in the dir > 300 lines (`wc -l`) | F1, F6 |
| RV-ARC-06 | eslint layering and cross-app blocks with fixture tests | M | — | `eslint.config.mjs`, `tools/lint-rules.test.ts` | New tests `core may not import adapters` and `apps may not import other apps` pass; `pnpm lint` exit 0 on main | F3 |
| RV-ARC-07 | `tools/check-cycles.mjs` wired into lint | S | RV-ARC-12 | new `tools/check-cycles.mjs`, root `package.json` | `node tools/check-cycles.mjs` prints `0 runtime cycles` and exit 0; a fixture cycle exits 1 (test `detects a runtime cycle`) | F3, F7 |
| RV-ARC-08 | Move `DeviceSession` to `device-session.ts`; extract `hub-wire.ts`; rename `notify-hub.ts` | M | before V3-C12 claimed, or after V3-C13 | `apps/relay/src/core/{relay-router,pg-notify-hub}.ts`, new `device-session.ts`, `hub-wire.ts` | `pnpm --filter relay exec vitest run` green; `ls apps/relay/src/core/pg-notify-hub.ts` fails; `grep -c "class " apps/relay/src/core/relay-router.ts` = 1 | F9, F2 |
| RV-ARC-09 | Explicit phone-core exports map; move phone-core tests into the package; delete the web shims | L | after V3-S13 or between sec-cards items (`card-safety` and mobile inbox are sec-cards) | `packages/phone-core/package.json`, `packages/phone-core/src/**/*.test.ts` (new location), `apps/web/src/{realtime,auth,pairing,ports}/*` shims, `apps/web/vitest` config | `grep -rln "^export \* from '@remote-control/phone-core" apps/web/src` = 0; `ls packages/phone-core/src/**/*.test.ts \| wc -l` ≥ 5; the exports map has no `*` key | F4 |
| RV-ARC-10 | test-harness phone reuses phone-core pairing and uuid; dedupe fake-phone helpers | M | RV-ARC-09 | `packages/test-harness/src/phone.ts`, `apps/agent/src/testing/fake-phone.ts` | `grep -c "rc/v1/pair-psk" packages/test-harness/src/phone.ts` = 0; e2e and harness tests green | F5 |
| RV-ARC-11 | `@simplewebauthn/browser` to devDependencies in phone-core | S | — | `packages/phone-core/package.json`, `pnpm-lock.yaml` (hotspot) | `node -e "process.exit(require('./packages/phone-core/package.json').dependencies['@simplewebauthn/browser']?1:0)"` exit 0; mobile typecheck green | F8 |
| RV-ARC-12 | Break the `main.tsx` ↔ `split.tsx` cycle via `use-wide-layout.ts` | S | — | `apps/web/src/screens/{main,split}.tsx`, new `use-wide-layout.ts` | `grep -c "from './main.js'" apps/web/src/screens/split.tsx` = 0 | F7 |
| RV-ARC-13 | Move `seededRandom` and one fake clock into test-harness; drop the agent → fake-claude-code ref if unused | M | RV-ARC-10 | `packages/fake-claude-code/src/*`, `packages/test-harness/src/*`, `apps/relay/src/testing/fake-time.ts`, about 10 agent tests, `apps/agent/tsconfig.json` | `grep -rn "seededRandom" packages/fake-claude-code/src` = 0; `tsc -b` exit 0 | F10, F5 |
| RV-ARC-14 | Break the type-only cycle `pending-store` ↔ `ports/agent-adapter` (move `PendingRequest` to `core/pending-request.ts`) | S | — | `apps/agent/src/core/pending-store.ts`, `ports/agent-adapter.ts`, new `core/pending-request.ts` | `check-cycles.mjs --types` reports no `agent` cycle | F3 |

Total: 5 S, 6 M, 3 L, about 29 h.

**Order for the collision-free path**
1. 01, 11, 12, 14 (any time)
2. 06, 07
3. 08 (before C12 is claimed)
4. 04 (before P3 opens)
5. 02 → 03 (while evidence, requester and rules are idle)
6. 05 (after A03)
7. 09 → 10 → 13 (after S13)

## 8. Open questions for the owner

- **Q-ARC-1.** Should the `arch` pseudo-lane be allowed to hold unowned hotspots (`cli/main.ts`,
  `session-hub.ts`, `realtime-client.ts`) for one item at a time, blocking other lanes from those
  files? *Default: yes, claimed on `main` like any lane.*
- **Q-ARC-2.** Should the version-gate lane get an explicit exception to "must not touch agent
  core", limited to the `relay-client.ts` hello? *Default: yes, scoped to that function only.*
- **Q-ARC-3.** Should phone-core tests move into the package now, or after TestFlight?
  *Default: after V3-S13, before the first TestFlight upload, so the noble path has package
  tests.*
- **Q-ARC-4.** Do the lint boundary rules (RV-ARC-06) block CI immediately, or warn for one
  wave? *Default: error immediately. `main` already passes them (V8).*

## 9. Sources

- Code (path:line as cited):
  - `apps/agent/src/{cli/main.ts, container.ts, core/session-hub.ts, core/relay-client.ts, core/pairing-code.ts, core/pending-store.ts, ports/*.ts, testing/fake-phone.ts}`
  - `apps/relay/src/{core/relay-router.ts, core/pg-notify-hub.ts, core/crockford-base32.ts, container.ts, ws/}`
  - `apps/web/src/{screens/main.tsx, screens/split.tsx, realtime/*, auth/*, pairing/*, ports/timer.ts}`
  - `apps/mobile/src/adapters/*`
  - `packages/phone-core/{package.json, src/realtime/*, src/pairing/pairing-code.ts, src/auth/relay-api.ts}`
  - `packages/test-harness/src/phone.ts`
- Config: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `tsconfig.json`,
  `apps/*/tsconfig*.json`, `apps/*/tsdown.config.ts`, `eslint.config.mjs`,
  `tools/lint-rules.test.ts`, `apps/agent/scripts/check-argv-policy.mjs`, `Dockerfile`.
- Commands: `tsc -b` (exit 0); `tsc -b --verbose --dry` (29 projects); `wc -l` over the
  non-test `*.ts(x)`; grep layering checks (V8); the scratch scripts `arc/cycles.py` and
  `arc/dup.py` in the session scratchpad.
- Docs: ROADMAP §1, §2 (D2, D6, D13), §5, §7 (R1–R19); `docs/analysis/v3/PARALLEL.md` §2–§5;
  `docs/analysis/v3/ROADMAP-v3.md` (V3-C12, C13, A03, A04, S02, P02); v2 V2-AG-03; ADR 0017.
