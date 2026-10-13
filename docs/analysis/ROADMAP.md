# remote-control — Roadmap

Status: 2026-10-12, v1. Synthesised from `00-brief.md`, `01-roles.md` and the seven
specialist reports in `reports/`. This is the execution plan. It is written for the
executor (Claude Opus 5.5, working one work package at a time) and for the owner (who
ratifies the decisions in §2 and answers §6).

Precedence: an owner instruction in chat > this file > the report of the role that owns
the topic (table in `01-roles.md`) > any other report. Where this file resolves a
conflict between reports, the resolution is marked **RESOLVED** and the losing option is
named, so nobody re-derives it.

<!-- release-progress:begin -->
## Release progress (Opus 5.5 hours)

> Maintained by the `relase-opus-5-5-persentage` skill. Unit: wall-clock hours
> of one autonomous Opus 5.5 session at this project's gate standard.
> Numbers are computed by the skill's script from the table below.

| | |
|---|---|
| Release target | `M1 — Second user` exit (§3): `remotectl@0.1.0` published + M1 exit record (current version `0.0.0`, no tags) |
| Progress | **65.3 %** — 63 h of 96.5 h earned |
| Remaining | **33.5 h** Opus 5.5 (2 h workable now, 31.5 h blocked) |
| Blocked by | domain + Railway deploy (Q2); device spike on iPhone/Android; first push (CI on GitHub, branch protection); npm placeholder + trusted publisher; second user named (Q13); two weeks of owner use; M1-04 chain waits on M0-23 (real CLI decided from the phone) |
| Calibration | Same-session sequential WP gaps (git log 2026-10-12/13): M0-14 ~1.0 h, M0-11 ~1.1 h, M0-20 ~0.7 h, M0-19 ~3.2 h; 37 WPs closed in ~20.5 h wall across 3–4 parallel sessions. Scale: S = 1 h, M = 2 h, L = 4 h; owner-gated tails 0.5–3 h of agent work each |
| Updated | 2026-10-13 at `727195e` |

| ID | Item | Source | Status | Est h |
|---|---|---|---|---|
| M0-01 | Monorepo scaffold and CI skeleton | §4 M0-01 | `done` | 2 |
| M0-02a | Relay skeleton, Dockerfile, Railway config (code part) | §4 M0-02 | `done` | 2 |
| M0-02b | Domain, Railway project, first deploy, /health over TLS | §4 M0-02, §6 Q2 | `blocked-owner` | 1.5 |
| M0-03a | Device spike page (code part) | §4 M0-03 | `done` | 1 |
| M0-03b | Device runs on iPhone + Android, device-spike.md GO/NO-GO | §4 M0-03 | `blocked-owner` | 1 |
| M0-04 | packages/log | §4 M0-04 | `done` | 1 |
| M0-05 | packages/protocol v1 | §4 M0-05 | `done` | 2 |
| M0-06 | packages/crypto (Noise KK/XXpsk0) | §4 M0-06 | `done` | 4 |
| M0-07 | packages/fake-claude-code | §4 M0-07 | `done` | 2 |
| M0-08 | Relay Postgres schema and migrator | §4 M0-08 | `done` | 2 |
| M0-09 | Relay accounts, passkeys, invite codes | §4 M0-09 | `done` | 2 |
| M0-10 | Relay WebSocket hub, presence, limits, shutdown | §4 M0-10 | `done` | 4 |
| M0-11 | Relay pairing slots, agent tokens, decision verification | §4 M0-11 | `done` | 2 |
| M0-12 | Relay Web Push adapter | §4 M0-12 | `done` | 2 |
| M0-13 | Agent package, CLI, config, keys, argv gate | §4 M0-13 | `done` | 2 |
| M0-14 | hook.js, hook receiver, pending store, hooks installer | §4 M0-14 | `done` | 2 |
| M0-15 | Claude Code adapter v0 | §4 M0-15 | `done` | 1 |
| M0-16 | Agent relay client, pairing, E2E sessions, decision intake | §4 M0-16 | `done` | 4 |
| M0-17 | packages/test-harness v0 | §4 M0-17 | `done` | 2 |
| M0-18 | PWA scaffold, probe, onboarding gate, theming | §4 M0-18 | `done` | 2 |
| M0-19 | PWA passkeys and per-action assertion | §4 M0-19 | `done` | 2 |
| M0-20 | PWA pairing, key store, realtime client | §4 M0-20 | `done` | 2 |
| M0-21 | PWA push subscription, service worker, approval card | §4 M0-21 | `done` | 2 |
| M0-22 | Journeys J1–J3, J5–J7 and the privacy gate | §4 M0-22 | `done` | 4 |
| M0-23 | Real Claude Code verification (held ≥ 11 min, decided from the phone) — needs M0-02b/M0-03b | §4 M0-23 | `blocked-owner` | 3 |
| M0-24 | Agent macOS launchd service | §4 M0-24 | `done` | 1 |
| M0-25 | CI completion: OS matrix, coverage, pg-real, browser vectors | §4 M0-25 | `done` | 2 |
| PUSH | First push: ci/agent-os/pg-real/image green on GitHub runners, fix runner-only failures, branch protection | §4 M0-25, M1-08 notes | `blocked-owner` | 3 |
| M0-26a | Sentry scrubbing, ops runbook (code part) | §4 M0-26 | `done` | 1 |
| M0-26b | Railway backups + restore drill, UptimeRobot, usage alert, Sentry DSN | §4 M0-26 | `blocked-owner` | 1 |
| M0-27a | SECURITY.md, README v0, publish settings (repo part) | §4 M0-27 | `done` | 1 |
| M0-27b | remotectl@0.0.1 placeholder on npm | §4 M0-27, §6 Q15 | `blocked-owner` | 0.5 |
| M0-EXIT | M0 exit record (real approval from outside home) | §4 M0 exit record | `blocked-owner` | 1 |
| M1-01 | AskUserQuestion end-to-end | §4 M1-01 | `done` | 2 |
| M1-02 | "Always" from the phone (session scope) | §4 M1-02 | `done` | 1 |
| M1-03 | "Reply in terminal", early handoff, remotectl pause | §4 M1-03 | `done` | 1 |
| M1-04 | Session registry, launcher, follow-up, J9–J11 — deps M0-23 | §4 M1-04 | `doing — code done f25cfea; real-CLI check pending M0-23 (ADR 0005)` | 4 |
| M1-05 | Live feed and thin session view, J8 — deps M1-04 | §4 M1-05 | `doing — code done d22c187; real-CLI check pending M0-23 (ADR 0005)` | 4 |
| M1-06 | Encrypted push summary | §4 M1-06 | `done` | 2 |
| M1-07 | Machines screen, checklist, onboarding self-test — deps M1-05 | §4 M1-07 | `doing — code done b69ecf3; real-CLI check pending M0-23 (ADR 0007)` | 2 |
| M1-08 | Linux and Windows services, uninstall, logs, update | §4 M1-08 | `done` | 2 |
| M1-09a | Tag-driven release pipeline (code part) | §4 M1-09 | `done` | 1 |
| M1-09b | First tagged publish remotectl@0.1.0 + release checklist executed | §4 M1-09, §3 M1 (2)(6) | `blocked-owner` | 1.5 |
| M1-10 | Revocation and deletion, J12 — deps M1-07 | §4 M1-10 | `done 5c11cfa — ahead of M1-07's real-CLI check (ADR 0009)` | 2 |
| M1-11 | Tool-label dictionary, card polish, local stats | §4 M1-11 | `done` | 1 |
| M1-12 | Playwright P1–P9 + WebKit smoke — deps M1-05 | §4 M1-12 | `done 5286172 — first CI run pending the next push` | 3 |
| M1-13 | Audit log and admin counters | §4 M1-13 | `done` | 1 |
| M1-14 | README final, screens doc, second-user run — deps M1-09, Q13 | §4 M1-14, §6 Q13 | `blocked-owner` | 1.5 |
| M1-15a | Soak harness, `pnpm soak` and CI load smoke (code part) | §4 M1-15 | `done 287eb9c` | 1 |
| M1-15b | 24 h soak run logged in `docs/verification/soak.md` | §4 M1-15 | `blocked-owner` | 0.5 |
| M1-EXIT | M1 exit record: two weeks, ≥ 20 approvals from outside home | §4 M1 exit record, §3 M1 (4) | `blocked-owner` | 1 |

### History
- 2026-10-13 `727195e` — 65.3 %, 33.5 h left (first run; target M1 exit; M2-04 and M2-08 are done but outside the target and not counted)
<!-- release-progress:end -->

## 0. How to execute this roadmap

1. **Read order.** This file first. Then `00-brief.md`. Then, per work package (WP), only
   the report sections the WP cites (`02 §5.4` means `reports/02-security.md`, section
   5.4). Do not read all seven reports in one context — they total ~3,700 lines; the
   analysis phase itself lost one agent to context overflow. Read sections by line
   range (`grep -n '^## \|^### '` first, then `sed -n`/`Read` with offset+limit).
2. **Unit of work = one WP** from §4. Sizes: S ≤ ½ day, M ≤ 2 days, L ≤ 1 week of a
   senior engineer. Execute in the listed order unless the `Deps` column allows an
   earlier start. One WP = one finished, committed item (several commits are fine if each
   is green). Never start a WP whose deps are not `done`.
3. **Gate** = `pnpm check` (typecheck, lint, format:check, test, build) green locally,
   then CI green on the PR. The WP's acceptance criterion (AC) is verified and the
   verification is stated in the commit body (one line: "AC: …"). A WP whose AC cannot
   be met is not done; say so in `WORKLOG.md` and stop.
4. **Decisions.** §2 lists decisions. `DECIDED` = owner decision or an unambiguous
   report conclusion — do not reopen. `RESOLVED` = a conflict between reports settled
   here — do not reopen without evidence from execution. `PROPOSED` = the default
   applies until the owner answers the matching question in §6. When execution proves
   a decision wrong, stop, write a one-page ADR in `docs/adr/NNNN-<slug>.md` (context,
   decision, consequences), and ask the owner before continuing.
5. **Status.** The `Status` column in §4 (`todo` / `doing` / `done <short sha>` /
   `dropped <reason>`) is updated in the same commit that finishes the WP.
   `WORKLOG.md` (local-only, never committed) gets a session entry.
6. **Owner's work rules** (global): everything in the codebase in English; no AI
   attribution anywhere in git history; one commit per finished item, only that item's
   files; `CLAUDE.md`, `CLAUDE.local.md`, `WORKLOG.md`, `.claude/`, `docs/ai/` are
   never committed (excluded in `.git/info/exclude`); push only when the owner says so;
   branch worktrees only under `~/Development/_branches/`; scratch only in
   `~/Development/_temp/` or the session scratchpad.
7. **Security rules that bind the executor** (from `02 §4.1`, non-negotiable): the
   relay never carries authority; the agent acts only on messages authenticated by a
   paired phone's E2E session; every machine-touching action (`allow`, `always`,
   `answer`, `instruct`, `start`) carries a user-verified WebAuthn assertion bound to
   that exact request; spawn argv and the project allow-list are local config that no
   protocol message can change; the agent's only inbound surface is a loopback hook
   endpoint with no "decide" API. A WP that would weaken any of these is wrong — stop
   and ask.

## 1. The product in one page

**Positioning** (`01 §5.1`): *One inbox for every coding agent on your own machines:
approve, answer, instruct and start sessions from your phone, from anywhere, with your
transcripts never stored off your machines.*

**Honest overlap** (`01 §1`, `01 §4.2`): for a single Claude Code user on a claude.ai
Pro/Max plan, Claude Code's built-in Remote Control already covers approvals, questions,
push, cross-machine session list, diffs and follow-ups. The README says so in a
comparison table. The reasons to build anyway: (a) several agents in one inbox; (b) users
on API keys / Bedrock / Vertex / gateways / ZDR who cannot use Remote Control; (c) no
transcript on a third-party server, E2E payloads, metadata-only relay; (d) "Always" from
the phone; (e) start a session in any allow-listed repository without the Desktop app;
(f) per-project history and cost.

**Kill criterion** (`01 §1.7`): if Anthropic ships "Always" from the phone plus a
non-Claude agent in Remote Control before M1 is done, stop and use Remote Control.

**Invariants** (hold in every milestone):

- I1 — *Nothing runs on the user's machine because the relay said so.* Every
  machine-touching action is a decision made on a paired, authenticated phone and bound
  to the exact request (`02 §5.4`).
- I2 — *The agent never leaves Claude Code hanging.* A request the agent cannot get
  decided is released or denied before Claude Code's own hook timeout, never held past
  it; a decision that cannot be delivered is dropped, never queued (`01 §1.4`, `03 §5.6`
  case 8, §2 D10).
- I3 — *The relay sees metadata only.* No message bodies, no transcripts, no push
  content it can read, no log line with a payload (`02 §5.6`, `06 §5.5`, `07 §5` privacy
  gate).
- I4 — *The agent is installable from one `npx` command and keeps itself running*, and
  never auto-updates its own code (`06 §5.3–5.4`).

**Success criteria** (`01 §1.6`): within two weeks of M1, the owner approves ≥ 20 real
requests from outside the home network with zero agent-caused hangs; a second user pairs
from the README in ≤ 10 minutes without help.

**Never** (`01 §5`, `06 §4`): a user-deployed relay; LAN pairing; chat through the
computer's API keys; a phone-editable allow-list; auto-update of the agent; Android
notification action buttons that decide without biometrics; a character / island UI.

## 2. Architecture decisions

Each entry: status, the decision, the losing alternatives, the sources. Executor: cite
the `D` number in commit bodies when a change implements it.

### D1 — Topology (DECIDED)
Phone PWA ↔ relay on Railway (one Fastify service + Railway Postgres, one origin for
static PWA, `/api/*` and `/ws`) ↔ home agent (Node daemon, outbound WSS only, loopback
HTTP for Claude Code hooks). No inbound port at home, no tunnel. Sources: brief §4,
`03 §5.1`, `03 §5.11`, `06 §5.1`.

### D2 — Monorepo, packages, stack pins (RESOLVED)
```
remote-control/
  apps/relay/              Fastify 5, @fastify/websocket 11, pg + drizzle-orm, web-push,
                           @simplewebauthn/server, pino; src/{core,ports,adapters,http,ws,db}
  apps/agent/              npm package "remotectl"; tsdown single-file ESM bundle; src/{core,ports,adapters,hooks,cli}
  apps/web/                React 19 + Vite 8 + vite-plugin-pwa 2 (injectManifest, src/sw.ts),
                           react-router 8, zustand 5, @simplewebauthn/browser, plain CSS
  packages/protocol/       zod 4 .strict() envelope + domain schemas, version negotiation; dep: zod only
  packages/crypto/         WebCrypto-only Noise KK / XXpsk0, HKDF, AES-GCM; Clock/Random ports
  packages/log/            shared pino config + redaction list (relay and agent)
  packages/fake-claude-code/  executable that reads a temp HOME/.claude/settings.json and fires hooks per the docs
  packages/test-harness/   in-process relay (PGlite, port 0), in-process agent, headless phone, FakeClock, push sink, log capture
```
Pins: Node 22 (`engines >=22`, `.nvmrc` 22; image/CI to Node 24 in H1 2027), pnpm via
`packageManager`, TypeScript `^6` (TS 7 when typescript-eslint supports it), vitest 5
with `test.projects`, Playwright, PGlite, tsx (dev), tsdown (agent bundle), eslint
(typescript-eslint recommendedTypeChecked) + prettier, drizzle-kit for migrations,
`fastify-type-provider-zod`. Ports & adapters as in kiko/agenthropic: `src/core` imports
no framework. `tsconfig.base.json` from agenthropic (ES2023, bundler, strict, composite,
project references).
Losing options: `node --test` (no fake timers / projects), tsup (unmaintained → tsdown),
TypeBox (zod 4 is the owner's kiko choice), `packages/test-fixtures` (03) — folded into
`packages/test-harness` (07). Sources: `03 §5.15`, `05 Rec-6`, `06 §5.3`, `07 §1`.

### D3 — E2E crypto and platform floor (RESOLVED)
`Noise_KK_25519_AESGCM_SHA256` for phone ↔ agent sessions (phone initiator, prologue
`"rc/v1" || user_id || phone_device_id || agent_device_id`, per-direction CipherState,
strict counter, AAD = canonical header so the relay cannot re-address, 256-byte padding,
64 KiB max frame, re-handshake on every reconnect). Pairing with
`Noise_XXpsk0_25519_AESGCM_SHA256`, PSK = 32-byte token the relay never sees. All
primitives via WebCrypto (`globalThis.crypto.subtle`) in both Node 22 and the browser.
**Platform floor: iOS 17+, Chrome Android ≥ 133** (first versions with X25519 in
WebCrypto). Consequence: the `@noble/curves` fallback proposed in `02 §5.1` is **not
built** in MVP; an unsupported browser gets a clear "update your browser" screen.
Losing options: P-256 ECDH baseline (05) — no Noise vectors for the suite, and the floor
makes it unnecessary; libsodium sealed boxes — no forward secrecy, WASM in the PWA.
Sources: `02 §5.1–5.3`, `05 §1.5`, `05 Q1`.

### D4 — The relay stores no messages: no outbox (RESOLVED, conflict 02+01 vs 03)
Report 03 proposed a Postgres `outbox` holding short-lived ciphertext for at-least-once
delivery across reconnects. Report 02 designed sessions that **re-handshake on every
reconnect** with per-session transport keys, and property P3 ("a frame recorded under
session S is rejected under session S'"). The two are incompatible: a frame stored while
the recipient was offline belongs to a session that no longer exists when the recipient
returns, so the outbox could never be drained after a reconnect — the only case it
would serve. Report 01's invariant ("a decision that cannot be delivered is dropped,
never queued") points the same way. **Resolution: no `outbox` table, no store-and-forward.**
- In-session delivery keeps 03's mechanics: envelope `id` (UUIDv7), per-`(from, session)`
  `seq`, `ack`, receiver LRU dedup, sender keeps unacked frames in memory and re-sends
  while the *same* session is alive.
- After every successful handshake the agent sends its **pending request set** (still
  unexpired) and a **session snapshot**; the phone re-sends any decision not yet acked
  (decide-once on the agent makes duplicates harmless).
- The relay keeps the hub, presence and ack-timers in memory, metadata in Postgres, and
  triggers Web Push from the plaintext header (`cls = request`) when the target phone
  has no live socket or does not ack within 3 s.
- 03's case table (`03 §5.6`) stays valid with "R stores the row" read as "A keeps it
  pending, R pushes"; 03 W7 (L) is replaced by the smaller M0-13 + M0-19 below.
Sources: `02 §5.2`, `02 §5.6`, `03 §5.6`, `01 §1.4`.

### D5 — Push payload (RESOLVED, conflict 02+03 vs 05; phased)
- **M0:** relay-composed, metadata-only payload `{t:"pending", rid, dev, exp}` (< 200
  bytes, `Topic` = request id, `Urgency: high`, `TTL` = remaining lifetime). The SW shows
  "Approval needed on <machine>"; tap opens `/requests/:rid`; the app connects,
  handshakes, receives the re-sent request and renders it. (`03 §5.16`, `02 §5.6`.)
- **M1:** the agent adds an opaque `push_blob` to each request envelope header: a
  one-line summary (project, plain-word tool label, one line of arguments — never file
  contents or secrets) encrypted with AES-256-GCM under a per-pairing **notification
  key** = HKDF-SHA-256(DH(phone_static, agent_static), info `"rc/v1/push"`). The relay
  copies the blob verbatim into the push payload (≤ 3.5 KB). The SW holds this key
  decrypt-only in IndexedDB; it can decrypt nothing else and sign nothing. Falls back to
  the generic text on any failure and always calls `showNotification` (WebKit drops the
  subscription after three silent pushes). (`05 Rec-1`.) PROPOSED detail: the derivation
  needs a one-paragraph sign-off against `02 §5.2` at WP time (no forward secrecy for
  summaries is accepted; the key rotates with re-pairing).

### D6 — Pairing input (RESOLVED, conflict 02 QR-first vs 05 code-first)
Typed **short code is the primary input**, QR is optional (M2). The agent's `pair`
command prints both. The QR carries the full 32-byte token; the code is 12 characters
Crockford base32 (60 bits) expanded to the PSK with HKDF. Protection for the shorter
code: single-use 5-minute slot, the agent aborts the slot after 3 failed handshakes,
fingerprints confirmed on both ends (`02 §5.3` step 3). ACCEPTED (owner, 2026-10-13, M0-16):
security sign-off that 60 bits + 3 attempts + 5 min is acceptable (02 rejected only a six-digit
code without lockout). Reason for the order: iOS has no native `BarcodeDetector`; the
ponyfill + camera flow is an S-sized add-on, not a dependency of M0. Sources:
`02 §5.3`, `05 Rec-8`, `05 Q5`.

### D7 — Decision binding and user verification (DECIDED)
Canonical decision JSON (sorted keys, no whitespace) `{v, kind, request_id,
request_hash, payload, issued_at, expires_at (= issued_at + 300), phone_device_id,
agent_device_id}`. The agent generates `request_id` and `request_hash` (SHA-256 of the
canonical tool name + input, or prompt + cwd) when the hook fires. Agent checks in order:
KK session, pending & unresolved, hash equal, `now < expires_at` and `now < hook
deadline − 10 s`, peer matches, and for kinds other than `deny` a WebAuthn assertion with
`challenge = base64url(SHA-256(canonical decision))`, UV bit set, `rpIdHash` correct.
The relay issues the challenge, verifies the assertion (`requireUserVerification`,
10-minute used-challenge set) and forwards only then (M0–M1); the agent additionally
verifies the ES256 signature with the passkey SPKI shipped at pairing in M2. One
biometric per Allow/Always/Answer/Instruct/Start; none for Deny or reads; WebAuthn
options requested on tap, not on arrival. Sources: `02 §5.4`, `05 Rec-4`, `01 Q4`.

### D8 — Accounts (RESOLVED, conflict 03 email vs 02 passkeys-only)
Passkeys only (`residentKey: required`, `userVerification: required`, conditional UI),
**no email address stored**, one single-use recovery code shown at registration,
`__Host-` session cookie `SameSite=Strict` (7 d idle / 30 d absolute), Origin and
`Sec-Fetch-Site` checks on every state-changing request and on the WS upgrade,
invite-code registration at launch. 03's email identifier loses (PII the relay does not
need). Sources: `02 §5.5`, `02 Q1`, `02 Q5`, `02 Q6`, `03 Q5`.

### D9 — Production domain before the first passkey (DECIDED)
WebAuthn credentials and push subscriptions bind to the RP ID (domain); a later move
invalidates every passkey. The owner buys the domain (≈ $10–15/year) and attaches it to
Railway (CNAME + TXT, free TLS) **before M0's device spike**, because the spike registers
the first passkey. `*.up.railway.app` is used for nothing that persists. Sources:
`05 §1.4`, `05 A4`, `06 R10`, `06 Q2`.

### D10 — Timeouts and the hold policy (RESOLVED, conflict 01 vs 03; see also D11)
Facts from 04 (`04 §2.1–2.2`, `04 §4.1`): a `PermissionRequest` hook that returns **no
decision** (empty stdout, exit 0) lets Claude Code's **own permission prompt appear** —
nothing is granted; a timed-out hook is a non-blocking error with the same effect;
`onFailure: "block"` would turn an error or timeout into a deny; exit 2 is not honoured
for this event; per-hook `timeout` has no documented maximum; while the hook holds,
**the terminal shows nothing** (assumption 04 A3, verified by WP M0-21), so the phone is
the only answerer until the hook returns.
**Resolution — "handoff", not deny** (04 Q2 default, matches 01's "never block"):
- The two blocking hooks get `timeout: 1800` (30 min, 04 Q1 default; the one knob,
  `hooks.holdSeconds` in agent config). 03's 600/570 s pair is superseded.
- `hook.js` itself **never fails**: any error (agent down, 401, bad JSON, its own
  deadline at `T − 5 s`) → empty stdout, exit 0 → the terminal prompt appears. Therefore
  `onFailure: "block"` is **not** set; a dead agent degrades to plain Claude Code (and to
  Anthropic's Remote Control if the user enabled it), never to an unattended "allow".
- The agent's `PendingStore` deadline is `T − 10 s`; at the deadline it answers the hook
  with no decision (`handoff`), marks the request `released`, and tells the phones
  `expired`. Decisions arriving after `handoff` are rejected (04 risk 8). The phone can
  trigger the same release early ("Reply in terminal", `01 W9`).
- `agent.onExpire: "handoff" | "deny"` (default `handoff`) is the only alternative, for
  users whose machines are unattended; `deny` returns `{behavior:"deny",
  message:"No decision from phone", interrupt:false}` so the session can continue.
- Decision validity stays 300 s from issue (D7); the phone shows the remaining hold time
  from `expiresAt` in the request envelope.
Losing option: explicit deny at `hookTimeout − 30 s` (03) — safe but hostile to the
user sitting at the desk; kept only as the opt-in above. Sources: `04 §2.2`, `04 §4.1`,
`04 §5.8`, `04 Q1–Q2`, `01 §1.4`, `01 W9`, `03 §5.6`, `03 Q1–Q2`, `02 §5.4`.

### D11 — Claude Code integration surface (DECIDED, from 04)
- **Hooks only, `command` type, our own `hook.js`** (CommonJS, no dependencies) —
  not `http` hooks (not allowed on `SessionStart`, token would live in Claude Code's
  environment, no place for our fail-open logic). Hook set installed into
  `~/.claude/settings.json` (respecting `CLAUDE_CONFIG_DIR`): blocking
  `PermissionRequest` and `PreToolUse` with matcher `^AskUserQuestion$` (timeout 1800);
  non-blocking `PostToolUse`, `UserPromptSubmit`, `Notification`, `Stop`, `SubagentStop`,
  `SessionStart`, `SessionEnd`, `PreCompact` (timeout 5, always exit 0, no output).
  `hook.js` reads stdin JSON, reads `agent.json` (`{port, token, generation}`, 0600,
  written by the agent at start in the env-paths data dir — D22 wins over 04's
  `~/.remote-control/`), POSTs to `http://127.0.0.1:4327/hook` with a bearer token, prints
  the agent's JSON verbatim. Loopback only, `Host` check, no browser `Origin` accepted,
  no "decide" route — decisions enter only through the relay channel (I1).
- **AskUserQuestion**: `PermissionRequest` does not fire for an already-allowed tool;
  the answer path is `PreToolUse` → `permissionDecision: "allow"` +
  `updatedInput: {questions, answers: {"<question text>": "<label>"}, response?}`.
  **Scope of 02 W11's argv/policy gate**: exactly one module (`claude-code/decide.ts`)
  may emit `updatedInput`, and only for `tool_name === "AskUserQuestion"`, copying
  `questions` verbatim from the hook input; a golden test asserts that an `allow` for any
  other tool carries no `updatedInput`. (`02 W8` "no rewriting of tool input" stays true
  for every real tool.)
- **"Always"**: `decision.updatedPermissions` in the `PermissionRequest` output with
  the rules from `permission_suggestions` and `destination: "session"` only (M1, D24);
  `localSettings`/`projectSettings` destinations are M2 behind an agent setting.
- **Start a session / follow-up** (`04 §4.2`, `04 §5.4`): the user's own CLI via
  **background sessions** — `claude --bg --name <name> "<prompt>"` with `cwd` = the
  allow-listed, Claude-trusted repository; follow-up `claude --resume <uuid> --bg
  "<text>"` for sessions with `kind: background`; UUID captured from the first
  `SessionStart` hook matching `name + cwd`, or from `claude agents --json`. Version gate
  `claude --version ≥ 2.1.257` at agent start (older → follow-up disabled, never a silent
  fork). Follow-up into a **foreground interactive** session is `unsupported` in MVP (the
  phone shows "attach in the terminal"). **The Agent SDK is rejected as the primary
  path**: Anthropic forbids claude.ai login in SDK products, so it would cost API tokens
  on top of the subscription; a `claude-sdk` adapter for API-key users is optional M3.
  A long-lived `claude -p --input-format stream-json` child is the fallback only if
  background sessions leave research preview in a breaking way (owner 04 Q4 default: no).
  tmux/pty: never. Spawn argv is the literal `["--bg", "--name", name, prompt]` in one
  module (D13); no `--permission-mode` from the phone in MVP (M2-09 adds a bounded one:
  ADR 0006).
- **Session identity and live view** (`04 §5.3`, `04 §5.5`): key = hook `session_id`;
  project = first `cwd` matched against the allow-list; `SessionRegistry` fed by hooks and
  enriched every 10 s from `claude agents --json --all` (`state`, `status`, `waitingFor`,
  `name`, `pid`) only while a session is known; stale after 24 h without events. The
  feed is built from **hook payloads** — `UserPromptSubmit.prompt`, `PostToolUse`
  (`tool_name`, `tool_input`, truncated `tool_response`; unified diff for
  `Edit`/`Write`/`MultiEdit` computed from `tool_input`), `Stop.last_assistant_message`,
  `SubagentStop`, `PreCompact`, `Notification` — **never from parsing transcripts** (the
  JSONL format is declared unstable). The agenthropic parser is an optional backfill
  behind a flag (M3).
- **Workspace trust** (`04 §2.1`): interactive sessions withhold *all* hooks until the
  folder is trusted in Claude Code. The installer says so; `remotectl status` reports
  per-repo "no hook seen yet"; the phone shows the hint instead of silence.
- **Coexistence** (`04 §5.6`): the installer merges by recognising our command path,
  never touches foreign entries, writes `settings.json.backup-<ts>`, temp file + rename;
  `remove` restores. Port 4327 (agenthropic uses 4317). Anthropic's Remote Control
  coexists: our hook decides first; after `handoff` its relay shows the prompt.
- Dedup: a repeated `PermissionRequest` for the same `session_id + tool_name +
  hash(tool_input)` within 2 s replaces the pending one (04 risk 11).
Sources: `04 §2.1–2.9`, `04 §4.1–4.2`, `04 §4.5`, `04 §5.1–5.8`, `02 W11–W12`, `01 W8`.

### D12 — Other agents (DECIDED: adapter boundary day one, second adapter in M2)
`packages/protocol` carries per-agent capability flags (`alwaysSupported`,
`questionsSupported`, `startSupported`, `instructSupported`, `diffsSupported`) and the
agent has an `AgentAdapter` port from day one (`04 §5.7`: `detect`, `installHooks`,
`removeHooks`, `onHook`, `decide`, `listSessions`, `start`, `followUp`); Claude Code is
the only adapter until M2.
**Second adapter = Codex CLI** (`04 §2.11`, `04 §4.4`): Codex now has lifecycle hooks
with `PermissionRequest` (`hookSpecificOutput.decision.behavior allow|deny`) and
`PreToolUse` (`permissionDecision allow|deny`) in the same JSON shape, `~/.codex/hooks.json`,
default timeout 600 s, synchronous — a full approve/deny adapter is feasible with one UX
cost: the user must trust the hook once with `/hooks` (installer prints it; `SessionStart`
canary in `status`). No question tool; follow-up via `codex exec resume` is unverified.
**Gemini CLI = observe + deny only** (M3): `BeforeTool` allow/deny gate, `Notification`
(`ToolPermission`) is observe-only, its own confirmation dialog cannot be answered from the
phone (04 A6). Capability flags make the UI honest about both. Sources: `01 §1.3`,
`01 Q2`, `04 §2.11–2.12`, `04 §5.9`, `04 Q6`.

### D13 — Agent hardening and supply chain (DECIDED)
Loopback-only bind with exit on failure, per-install hook token, `realpath` allow-list
check (symlink, `..`, trailing-space fixtures), CI static gate
`scripts/check-argv-policy.mjs` (only the spawn module imports `child_process`; argv is a
literal; forbidden tokens `--dangerously-skip-permissions`, `bypassPermissions`,
`--allowedTools`, `--settings`; `dontAsk` and the single bounded `--permission-mode`
literal from ADR 0006 since M2-09), npm trusted publishing with provenance, `npm audit
signatures` in CI, pnpm `minimumReleaseAge`, `files` whitelist, zero runtime
dependencies in the published bundle, no `postinstall`, notify-only update check
(`remotectl update` is run by the user). Sources: `02 §5.8`, `02 W11–W13`, `06 §5.3`.

### D14 — Protocol envelope and versioning (DECIDED)
Envelope `{v, id (UUIDv7), from, to, session, cls (request|reply|command|event|control),
seq, ts, expiresAt, replyTo?, payload (opaque bytes)}`; control frames `hello`,
`hello_ok` (presence snapshot, `min_supported`), `ack`, `presence`, `ping`/`pong`,
`error`; zod `.strict()` on every frame (unknown key → close 1008); `v` on every
envelope; additive-only changes; relay supports current and previous major; the agent
sends its package version + protocol version in `hello`. Product vocabulary
(`machine`, `repository`, `session`, `request`, `question`, `decision`, `instruction`,
`startSession`) from `01 W2`. Sources: `03 §5.5`, `03 §5.10`, `02 W2`, `01 W2`.

### D15 — Relay runtime behaviour (DECIDED)
One WS per device, authenticated before upgrade (cookie + Origin for phones, bearer
token for agents); in-memory `LocalHub` `userId → Map<deviceId, conn>` behind a `HubPort`
(a `PgNotifyHub` on LISTEN/NOTIFY is the post-MVP path to two replicas; no Redis);
presence derived from hub membership and exposed as server timestamps; heartbeat ping
25 s, terminate after 35 s silence; frame cap 256 KiB (1009), 100 frames/s (1008),
backpressure on `bufferedAmount` > 1 MiB; second socket for a device closes the first
(4000); graceful shutdown on SIGTERM: stop accepting, close every socket 1012, `/health`
503, exit within 25 s (Railway `drainingSeconds` 30 — 06's value wins over 03's 15).
Sources: `03 §5.2–5.4`, `03 §5.13`, `06 §5.1`, `05 Rec-5`.

### D16 — Railway and operations (DECIDED)
Hobby plan from day one (Free is unusable: 0.5 GB RAM, 3-day logs), region
`europe-west4-drams3a`, Dockerfile build (multi-stage, `pnpm deploy --prod`, `USER
node`, PWA `dist` copied into the relay image), settings in `.railway/railway.ts`
(Config as Code is deprecated, cutoff 2026-12-01): healthcheck `/health` 100 s, restart
`ON_FAILURE` × 10, `drainingSeconds 30`, `overlapSeconds 20`, pre-deploy
`node dist/migrate.js`, watch paths; Serverless off; 1 replica; GitHub integration with
"Wait for CI", no `railway up` from CI, no PR environments, no staging until a second
real user; Railway backups on + one restore drill; UptimeRobot on `/health` → e-mail;
Railway usage alert $8 / hard limit $15; Sentry free tier on the relay only;
Dependabot weekly grouped. Cost ≈ $6–7/month at the start. Sources: `06 §5.1–5.7`.

### D17 — Migrations (RESOLVED, 03 boot vs 06 pre-deploy → both, one module)
`drizzle-kit generate` produces SQL; `apps/relay/src/db/migrate.ts` (built to
`dist/migrate.js`) applies forward-only migrations under a Postgres advisory lock. Railway
runs it as the pre-deploy command (a broken migration fails the deploy before traffic
switches); the relay also runs it at boot (idempotent) so local dev and the test harness
need no extra step. Sources: `03 §5.9`, `06 §5.1`, `06 W9`.

### D18 — Test strategy (DECIDED)
Fakes before features: `packages/fake-claude-code` and `packages/test-harness` are M0
WPs that precede every feature WP. vitest `test.projects`; PGlite on every PR (all three
OSes, no Docker), real Postgres `services:` job on `main` + nightly; 12 in-process
journeys (pair, allow, deny, question, expiry, agent offline, phone offline,
sessions/diff, instruction, new session, allow-list refusal, revoke) under 60 s; crypto
vectors (RFC 7748 §6.1, RFC 5869 case 1, Noise KK / XXpsk0 published vectors) in Node on
every PR and in Chromium + WebKit on `main`; privacy gate (canary strings in every
payload; logs, DB dump and push bodies scanned after each journey; planted-leak
meta-test); coverage thresholds 100 % protocol/crypto, 90/85 agent/relay, 80/70 web;
`agent-os` matrix (ubuntu, macOS, Windows) on every PR; Playwright (iPhone emulation,
CDP virtual authenticator, `PushEvent` dispatched in the SW) on `main`, nightly and the
`e2e` label; a manual release checklist for real iPhone push, Face ID, real Claude Code
and Railway. Sources: `07 §1`, `07 §5`, `02 §7.1–7.2`.

### D19 — Logging and the metadata promise (DECIDED)
`packages/log`: pino with `level` as a label, fields `req_id`, `user_id` (opaque),
`device_id`, `event`, `bytes`, `duration_ms`, `ws_close_code`; redact
`req.headers.authorization`, `req.headers.cookie`, `*.token`, `*.secret`, `*.payload`,
`*.ciphertext`, `*.push_endpoint`, `*.challenge`, `*.pairing_code`, `*.password`;
never log payloads (encrypted or not), push endpoints, WebAuthn material, pairing codes,
full user agents at `info`. Audit log rows carry event, user, device, timestamp — no
bodies. Sources: `06 §5.5`, `02 W9`, `03 W12`.

### D20 — Milestones (RESOLVED: 01's reorder replaces the brief's M1–M4)
M0 walking skeleton → M1 second user → M2 beyond Claude Code (§3). The brief's four MVP
items are all still in scope; item 4 (other agents) lands in M2 with the adapter
boundary in the protocol from M0.

### D21 — Session view depth (DECIDED)
M1 ships the thin view: state, last prompt, ≤ 20 steps, last answer, changed files with
`+N −M`, no full paths without a tap, no diff bodies. Diff bodies (unified, `diff`
`parsePatch`, hunk collapse) are M2. Sources: `01 §1.3`, `01 Q6`, `05 Rec-7`, `05 W11`.

### D22 — Agent packaging, paths and lifecycle (DECIDED)
npm name `remotectl` (free; reserve with `0.0.1` in week 1), bin `remotectl`, commands
`pair | install | uninstall | status | run | logs | update | devices`. Paths via
`env-paths('remotectl', {suffix: ''})`: device keys and `peers.json` (0600) in `data`,
config in `config`, logs in `log` (pino-roll 10 MB × 5). Services: launchd user agent
(`KeepAlive`), `systemd --user` + `loginctl enable-linger`, Task Scheduler ONLOGON task
from XML with `ExecutionTimeLimit PT0S`. `install` detects an npx cache path and refuses
with the global-install command instead (ADR 0002 supersedes the original "global
install first"). The daemon never exits on relay disconnect (jittered backoff
1 → 60 s); exit is reserved for fatal config errors. 02's `~/.config/remote-control/`
path loses to env-paths. Sources: `06 §5.3–5.4`, `02 §5.3`.

### D23 — Realtime on the phone (DECIDED)
WebSocket only while the app is visible; heartbeat 25 s; reconnect with backoff
1 → 30 s on `visibilitychange`, `pageshow`, `online` and on SW messages; on every
(re)connect: handshake, then the agent's pending set + snapshot arrive (D4), then
`GET /api/state` for relay-side metadata (machines, presence timestamps); polling
fallback every 15 s after two socket failures; "machine offline — last seen N min ago"
rendered from the relay's `agentLastSeenAt`, never from the phone's own socket state.
SSE and long polling lose. Sources: `05 Rec-5`, `03 §5.2`.

### D24 — "Always" from the phone (PROPOSED)
M1: `always` maps to `updatedPermissions` with **session** scope only; project-settings
scope in M2 behind a setting. Default from `01 Q3`; mechanism confirmed by 04 (D11).

### D25 — Multiple phones and machines (DECIDED)
One KK session per (phone, agent) pair; requests fan out to all phones; the first decision
the agent accepts wins and it emits `resolved` so other phones dismiss the card; device
cap 10 per user; multi-machine pairing and listing in M0/M1, no machine-specific
features. Sources: `02 §5.2`, `03 §5.6` case 6, `01 Q7`, `03 Q6`.

## 3. Milestones

| Milestone | Goal | Exit criteria (all must hold) |
|---|---|---|
| **M0 — Walking skeleton** | The owner, away from home, allows or denies one real Claude Code permission request from the phone, end-to-end encrypted, with a push notification; everything deployed, installed and tested the way it will stay. | (1) Device spike `docs/verification/device-spike.md` says GO. (2) Relay live at the production domain on Railway Hobby, deployed by CI. (3) `remotectl` installed via `npx` on the owner's Mac, kept alive by launchd. (4) Journeys J1 pair, J2 allow, J3 deny, J5 expiry, J6 agent offline, J7 phone offline green in CI on three OSes; privacy gate green; coverage thresholds enforced. (5) `docs/verification/claude-code-hooks.md` records a real request held ≥ 11 min and decided from the phone, Claude Code version noted. (6) SECURITY.md published; no message table in the schema. |
| **M1 — Second user** | A second, named user installs from the README in ≤ 10 min; the owner uses it daily: questions, Always, follow-ups, new sessions, thin session view, readable notifications. | (1) J4 question, J8 sessions, J9 instruction, J10 new session, J11 allow-list refusal, J12 revoke green. (2) `remotectl@0.1.0` published by trusted publishing; installers for macOS and Linux (Windows allowed to slip). (3) Second-user usability run logged in `docs/verification/second-user.md`, ≤ 10 min, no help. (4) Two weeks of owner use: ≥ 20 approvals from outside home, zero agent-caused hangs (`docs/verification/m1-usage.md`). (5) Playwright P1–P9 + WebKit smoke green on `main`. (6) Release checklist executed once. |
| **M2 — Beyond Claude Code** | The product reasons (a) multi-agent, (f) history/cost and the comfort features: Codex adapter, diff bodies, QR pairing, desktop layout, agent-side assertion verification. | (1) Codex journey green with the fake + a manual log with real Codex. (2) Agent verifies WebAuthn assertions itself (02 phase 2). (3) Diff viewer on the phone. (4) History/cost counters per project. |
| **M3 — Backlog** | Not planned, listed so nobody re-analyses: Gemini observe+deny adapter, `claude-sdk` adapter for API-key users, transcript backfill, `PgNotifyHub` + 2 replicas, Node 24 image, staging environment, native wrappers. | — |

**Critical path for one executor** (from 07 §7 and the dependency graph below):
M0-01 → M0-05 → M0-06 → M0-08 → M0-10 → M0-13 → M0-14 → M0-16 → M0-18 → M0-20 →
M0-21 → M0-22 → M0-23. M0-02/M0-03 (domain, Railway, device spike) run as early as the
owner's domain purchase allows and gate M0-18 onwards. Everything else slots in where
its deps are met.

## 4. Work packages

Format: ID — title · Size · Deps · Status · Sources. *Scope* lists what is built;
*AC* is the acceptance criterion. "Journey" = a `packages/test-harness` scenario file
(07 §5). Every WP that adds behaviour also adds or extends its tests in the same commit;
a WP without a listed test still runs under the coverage thresholds of D18.

### M0 — Walking skeleton

#### M0-01 — Monorepo scaffold and CI skeleton
Size M · Deps — · Status done a97d807 (CI-on-PR pending first push) · Sources 03 W1, 06 W1–W2, 07 W1–W2
Scope: pnpm workspace with `packageManager`, `engines >=22`, `.nvmrc`;
`tsconfig.base.json` (from agenthropic) + project references; empty packages per D2 with
one passing test each; eslint (typescript-eslint `recommendedTypeChecked`, `no-restricted-
globals` for `Date.now`/`Math.random`/`crypto.getRandomValues` outside the `Clock`/`Random`
ports, `no node:crypto` outside `packages/crypto` adapters) + prettier; root
`vitest.config.ts` with `test.projects` (`apps/web` under jsdom); scripts `check`
(`typecheck && lint && format:check && test && build`); `.github/workflows/ci.yml`
(ubuntu, Node 22, pnpm cache, `pnpm check`); `.gitignore`; LICENSE MIT; `.editorconfig`.
AC: `pnpm check` green locally; `ci` green on a PR; a test using `Date.now()` directly
fails lint.

#### M0-02 — Domain, Railway project, Dockerfile, relay skeleton, first deploy
Size M · Deps M0-01 · Status doing — code done 01a8408; domain, Railway and first deploy pending owner (Q2) · Sources 03 W3, 03 W13, 06 W4–W9, 06 W19, 06 R10
Scope: **owner buys the domain** (§6 Q2) and adds it to Railway (CNAME + TXT); Railway
project (Hobby, `europe-west4-drams3a`, Postgres, `relay` service) described in
`.railway/railway.ts` per D16; multi-stage Dockerfile (`node:22-bookworm-slim` by digest,
`pnpm deploy --prod`, `USER node`, PWA `dist` copied in) + `.dockerignore`; relay
skeleton: `buildApp()` factory, `/health` (200 while serving, 503 while draining, checks
DB), static serving with SPA fallback, `GET /api/version`; `docker-compose.yml` with
Postgres + `.env.example`; `pnpm dev:https` with mkcert documented for phone-on-LAN;
GitHub integration with "Wait for CI"; Serverless off; watch paths.
AC: `https://<domain>/health` → 200 with valid TLS from the Railway deploy triggered by a
push to `main`; `/health` unit test covers the 503 draining case; `docker build` runs
as non-root.

#### M0-03 — Device feasibility spike (GO / NO-GO for the PWA)
Size M · Deps M0-02 · Status doing — code done 81021f0; device runs pending owner (domain Q2, iPhone + Android) · Sources 05 W1, 05 §4, 01-roles "native engineer"
Scope: a throwaway page at the production domain (so passkeys bind to the final RP ID):
installability on iPhone (Safari 17+) and Android Chrome; `PushManager.subscribe` in the
installed app; push received with the app closed and the phone locked; tap opens a
route; `navigator.credentials.create/get` with `userVerification: required` inside the
installed app (Face ID / fingerprint); `crypto.subtle` X25519 `generateKey`/`deriveBits`.
Record device, OS version, outcomes, timings.
AC: `docs/verification/device-spike.md` with a GO/NO-GO line per capability on at least
one iPhone and one Android device; NO-GO on push or UV → stop and ask the owner (native
wrapper or scope change) before any PWA WP.

#### M0-04 — `packages/log`
Size S · Deps M0-01 · Status done 9368965 · Sources 06 W11, 02 W9, 03 W12
Scope: shared pino factory (level label, `req_id`, `user_id`, `device_id`, `event`,
`bytes`, `duration_ms`, `ws_close_code`), redaction list per D19, `pino-roll` option for
the agent, canary helper `assertNoCanary(logLines, canaries)` reused by the privacy gate.
AC: a test logs an object containing every redacted path and a canary string; the
rendered line contains neither.

#### M0-05 — `packages/protocol` v1
Size M · Deps M0-01 · Status done 142a344 · Sources 03 W2, 02 W2, 01 W2, 01 W5, 07 W7
Scope: zod 4 `.strict()` schemas for the envelope and control frames (D14); domain
schemas with 01 W2's vocabulary (`machine`, `repository`, `session`, `request`,
`question`, `decision`, `instruction`, `startSession`, `capabilities`); request
lifecycle `pending → decided | released | expired | undeliverable | superseded` as a
typed state machine with a transition table; canonical decision JSON + `decisionHash()`
(D7); `requestHash()` over canonical tool input; version table (`v`, `min_supported`);
`Clock`/`Random` ports; golden fixtures under `packages/protocol/fixtures/` incl. a
frozen decision-hash vector.
AC: 100 % line coverage; round-trip and rejection tests for every schema (unknown key
rejected); state-machine test enumerates every legal and illegal transition; the frozen
decision hash matches.

#### M0-06 — `packages/crypto`
Size L · Deps M0-01, M0-05 · Status done a381684 (browser run pending M0-25) · Sources 02 W3–W5, 02 §7, 07 W8–W9, D3
Scope: WebCrypto-only primitives (X25519, HKDF-SHA-256, AES-256-GCM, SHA-256) with a
capability probe; Noise `KK` and `XXpsk0` state machines over `25519_AESGCM_SHA256`;
transport session (per-direction CipherState, strict counter nonce, AAD = canonical
header bytes, 256-byte padding, 64 KiB max, rekey-on-reconnect); fingerprint
derivation for pairing confirmation; notification-key derivation (D5, M1-06 uses it).
Tests: RFC 7748 §6.1 and RFC 5869 case 1 vectors, Noise KK/XXpsk0 vectors from the
`cacophony`/`snow` suites committed under `fixtures/` with a regeneration test, properties
P1–P12 from 02 §7.1 (replay, reorder, truncation, cross-session, peer swap, wrong PSK,
wrong prologue, padding, max frame, nonce exhaustion, AAD tamper, revocation), no
`node:crypto` import anywhere (lint). Vector spec also runs in Chromium + WebKit (07 W9)
once M0-18 exists.
AC: 100 % coverage; all vectors and properties green in Node; the same vector spec file
is wired to run in the browser on `main` (M0-25 adds the job).

#### M0-07 — `packages/fake-claude-code`
Size M · Deps M0-01, M0-05 · Status done 28b7ee9 (ubuntu/Windows runs pending M0-25) · Sources 07 W3–W4, 04 §2, 04 W7
Scope: a `fake-claude` executable (`private: true`) that reads
`$HOME/.claude/settings.json` from a temp HOME, resolves matchers, runs `command` hooks
with the documented stdin payloads from 04 §2 (PermissionRequest, PreToolUse
AskUserQuestion, PostToolUse, UserPromptSubmit, Notification, Stop, SubagentStop,
SessionStart/End, PreCompact), maps exit codes and timeouts, honours `onFailure` and
`async`, writes a minimal transcript; scenario scripts (`permission`, `question`,
`tools`, `stop`, `held`); CLI surface used by the agent: `--version`, `--bg --name`,
`--resume <uuid> --bg`, `agents --json`; `fixtures:anonymise` recorder for real hook
payloads (forbidden-string regex, key-set snapshot).
AC: conformance suite ≥ 15 cases green on ubuntu, macOS, Windows (M0-25 wires the
matrix); anonymiser test rejects a payload with a canary path.

#### M0-08 — Relay: Postgres schema and migrator
Size M · Deps M0-02 · Status done be2f007 (started on the M0-02 code part) · Sources 03 W4, 06 W9, 02 §5.6, D17
Scope: drizzle schema per 02 §5.6 — `users`, `passkeys`, `recovery_codes`, `devices`,
`pairings`, `push_subscriptions`, `sessions` (metadata only: ids, timestamps, state),
`agent_tokens`, `pairing_slots`, `audit_log`; **no table with a payload column**;
`src/db/migrate.ts` → `dist/migrate.js` with advisory lock, forward-only, run at boot and
as Railway pre-deploy; `drizzle-orm/pglite` driver for tests and `pg` for production
behind one `Db` port.
AC: migrations apply on PGlite in tests and on Postgres in `pg-real`; a schema test
asserts no column named `payload`, `body`, `ciphertext` or `content` exists; boot with
two concurrent migrators runs each migration once.

#### M0-09 — Relay: accounts, passkeys, invite codes
Size M · Deps M0-08 · Status done 7a4568f · Sources 02 W7, 02 W10, 02 §5.5, 03 W5, D8
Scope: `@simplewebauthn/server` registration (invite code required, `residentKey:
required`, UV required, `rp.id` = domain) and login (conditional UI), one-time recovery
code (hash stored), `__Host-` cookie (`SameSite=Strict`, 7 d idle / 30 d absolute),
Origin + `Sec-Fetch-Site` checks, per-IP and per-user rate limits, admin CLI to mint
invite codes, `audit_log` rows for register/login/revoke.
AC: integration tests with a software authenticator cover register, login, wrong origin,
replayed challenge, expired cookie, invalid invite; cookie attributes asserted.

#### M0-10 — Relay: WebSocket hub, presence, limits, shutdown
Size L · Deps M0-05, M0-09 · Status done 7e52ec8 · Sources 03 W5–W6, 03 W8, 02 W10, 06 W8, D15
Scope: `/ws` upgrade authenticated before accept (cookie for phones, bearer agent token
for agents), `hello`/`hello_ok` with version negotiation and presence snapshot, `LocalHub`
behind `HubPort`, per-user routing with tenant isolation, `ack` + in-memory ack timers,
presence events with server timestamps, ping 25 s / terminate 35 s, 256 KiB frame cap,
100 frames/s, backpressure, second socket closes the first (4000), device cap 10,
SIGTERM drain (1012, `/health` 503, exit ≤ 25 s), `GET /api/state?since=`.
AC: tests with real `ws` clients on port 0: cross-tenant frame never delivered; oversized
frame → 1009; flood → 1008; silent peer terminated at 35 s with FakeClock; drain closes
every socket with 1012 and the process exits.

#### M0-11 — Relay: pairing slots, agent tokens, decision verification
Size M · Deps M0-10 · Status done d300194 · Sources 02 W6, 02 W8, 02 §5.3–5.4, D6, D7
Scope: `POST /api/pairings` (agent opens a 5-min single-use slot), phone joins by code
hash, relay passes XXpsk0 frames opaquely and binds the resulting `agent_device_id ↔
phone_device_id` pairing; agent token issuance at enrolment (`rc-enroll:` pasted token,
02 Q2) and rotation; decision verification: `POST /api/decisions/challenge` returns a
WebAuthn challenge = the phone-supplied `decision_hash`, `POST /api/decisions/verify`
checks the assertion (`requireUserVerification`, 10-min used-challenge set) and records
`verified(decision_hash)`; the hub forwards a `cls: command` frame whose header carries
`decision_hash` only when verified.
AC: tests: slot expires at 5 min; second join refused; unverified decision frame dropped
with `error: unverified`; replayed assertion refused.

#### M0-12 — Relay: Web Push adapter
Size M · Deps M0-10 · Status done e2da9a5 · Sources 03 W9, 03 §5.16, 07 W19, D5
Scope: `web-push` with VAPID keys from env, subscription CRUD (`push_subscriptions`),
metadata payload `{t:"pending", rid, dev, exp}`, `Topic` = rid, `Urgency: high`, `TTL` =
remaining lifetime, trigger when a `cls: request` frame targets a phone with no live
socket or unacked after 3 s, 404/410 → subscription deleted, rate cap per device;
`PushPort` with a fake push service in tests asserting VAPID `Authorization`, `TTL`,
`Urgency`, aes128gcm body ≠ plaintext.
AC: unit + fake-service tests for every bullet; payload size test < 200 bytes.

#### M0-13 — Agent: package, CLI, config, keys, argv gate
Size M · Deps M0-01, M0-04, M0-06 · Status done 667a429 · Sources 06 W14, 06 W18, 02 W11–W12, 03 W10, D13, D22
Scope: `apps/agent` as npm `remotectl` (bin, shebang, tsdown single-file ESM, zero
runtime deps, `files` whitelist, no `postinstall`); commands `run`, `status`, `pair`,
`devices`, `hooks install|remove|status`, `logs` (install/uninstall land in M0-24/M1-08);
`env-paths('remotectl')` layout; config file with the **repository allow-list** (absolute,
`realpath` at check time, symlink/`..`/trailing-space fixtures), `hooks.holdSeconds`
(1800), `agent.onExpire` (`handoff`); device static key + `peers.json` at 0600; pino-roll
logs; `scripts/check-argv-policy.mjs` CI gate (only `claude-code/spawn.ts` imports
`child_process`; argv literal; forbidden tokens).
AC: tests for allow-list edge cases; the argv gate fails on a planted forbidden token;
`remotectl --help` lists the commands; bundle has no runtime dependency (`npm pack`
inspection test).

#### M0-14 — Agent: `hook.js`, hook receiver, pending store, hooks installer
Size M · Deps M0-13, M0-07 · Status done 2528d9d · Sources 04 W1–W3, 04 §5.2, 04 §5.6, 04 §5.8, 01 W8, D10, D11
Scope: `hook.js` (CommonJS, no deps; stdin → POST `127.0.0.1:4327/hook` with bearer
from `agent.json`; waits until `T − 5 s`; prints the agent's JSON verbatim; any failure
→ empty stdout, exit 0); `HookReceiver` (Fastify, loopback bind with exit on failure,
constant-time token compare, `Host` check, browser `Origin` rejected, no decide route);
`PendingStore` (id, sessionId, kind, deadline `T − 10 s`, resolver; one in-flight per
`session_id + kind`, duplicate within 2 s replaces; at deadline → `handoff` and
`released`; late decisions rejected); `hooks install|remove|status` merging the D11 hook
set into `~/.claude/settings.json` (recognise own entries by command path, foreign
entries byte-identical, `settings.json.backup-<ts>`, temp + rename, `CLAUDE_CONFIG_DIR`,
corrupt JSON refused with a message); trust hint in `status`.
AC: `hook.js` unit tests with a fake receiver (agent down, 401, timeout, success → exit 0
and empty stdout on every failure); receiver holds a request 5 s then resolves `allow`;
expired request returns `{}`; installer fixture with the owner's `usage-monitor.js` and an
agenthropic entry round-trips byte-identical except our entries; `remove` after
`install` restores the fixture.

#### M0-15 — Agent: Claude Code adapter v0 (PermissionRequest)
Size S · Deps M0-14 · Status done c37edb8 · Sources 04 W4, 04 W6, 04 §5.7, D12
Scope: `AgentAdapter` port (04 §5.7) + `claude-code` adapter: `onHook` for
`PermissionRequest` → `request` (with `permission_suggestions` → `alwaysSupported`),
`SessionStart`/`SessionEnd` → registry seed; `decide` for `allow` / `deny` (`message`,
`interrupt: false`) / `handoff` (empty); capability flags. No `updatedInput` for any tool
yet (M1-01 adds the single AskUserQuestion exception).
AC: golden tests with 04 §2.2 JSON produce the documented outputs; a test asserts
`allow` never carries `updatedInput` here.

#### M0-16 — Agent: relay client, pairing, E2E sessions, decision intake
Size L · Deps M0-15, M0-11, M0-12, M0-06 · Status done be5c40b (QR carries the code-derived PSK, full 32-byte QR token deferred to M2; userId from the relay on token rotation, `login --user-id` is an optional cross-check) · Sources 04 W9, 02 W6, 02 W8, 03 W10, D4, D7
Scope: outbound WSS client (hello with package + protocol version, jittered backoff
1 → 60 s, never exits on disconnect); `remotectl pair` (opens a slot, prints the 12-char
code and the `rc1:` QR text, XXpsk0 responder, fingerprint shown, 3-failure abort,
`peers.json` write); KK responder per paired phone with the D3 prologue; after each
handshake: send the pending set with remaining TTL + session snapshot; decision intake
with the D7 check order (session, pending, hash, expiry, deadline − 10 s, peer, relay
`verified` flag in M0), decide-once, `resolved` fan-out to other phones; `instruct`/
`start` return `unsupported` until M1-04.
AC: fake-relay tests: pending request survives a reconnect and is re-sent; a late
decision is rejected; a decision with a wrong hash is rejected; two phones — first wins,
second receives `resolved`; `remotectl pair` against the test relay produces a usable
`peers.json`.

#### M0-17 — `packages/test-harness` v0
Size M · Deps M0-10, M0-12, M0-16 · Status done 9ccb0e8 (AC budget measured after the relay database boots; agent tsbuildinfo moved into dist/) · Sources 07 W6, 07 W19, 03 §5.15
Scope: in-process relay (`buildApp` on PGlite, port 0, fake push service, log capture),
in-process agent (temp HOME, fake-claude on PATH, loopback port 0), headless phone (Node
WebCrypto + `ws`, software WebAuthn authenticator from `@simplewebauthn` test utils,
pairing, KK initiator, decision signer), `FakeClock` wired through every `Clock` port,
canary strings injected into every fixture payload, `scenario()` builder.
AC: a smoke scenario pairs a headless phone with the in-process agent and exchanges one
encrypted frame in < 5 s.

#### M0-18 — PWA scaffold, capability probe, onboarding gate, theming
Size M · Deps M0-03, M0-05, M0-06 · Status done bcd9940 (ahead of M0-03 per ADR 0004; Lighthouse on the deployed build pending M0-02) · Sources 05 W2–W3, 05 W13, 05 Rec-3, 01 W3
Scope: Vite 8 + React 19 + `vite-plugin-pwa` (injectManifest, `src/sw.ts`), manifest
(name, icons, `display: standalone`, theme), routes per 01 W3 / 05 Rec-7 (`/login`,
`/onboarding/*`, `/machines`, `/sessions`, `/sessions/:id`, `/requests/:id`, `/new`),
capability probe (standalone, `PushManager`, `PublicKeyCredential`, X25519) with the
"update your browser" and "install first" screens, onboarding gate order passkey →
install → notifications → pair, safe-area insets, dark/light, 44 px targets;
`docs/product/screens.md` with the screen inventory.
AC: probe unit tests for each capability combination; the route table renders in jsdom;
Lighthouse PWA installability passes on the deployed build.

#### M0-19 — PWA: passkeys and per-action assertion
Size M · Deps M0-18, M0-09 · Status done d67ee16 (Playwright P1 prepared, runs in M1-12; the tap → fetch → `credentials.get` gesture on iOS confirmed by the M0-03 device runs) · Sources 05 W5–W6, 05 Rec-4, 02 W8
Scope: registration with invite code, conditional-UI login, recovery-code display with
"I saved it" confirmation, session state in zustand, `assertDecision(decision)` helper
(challenge = hash from `packages/protocol`, UV required, options requested on tap).
AC: tests with a mocked `navigator.credentials`; Playwright P1 register + login with the
CDP virtual authenticator (wired in M1-12, prepared here).

#### M0-20 — PWA: pairing, key store, realtime client
Size M · Deps M0-19, M0-11, M0-16 · Status done 2eb7d0d (on-device pairing and reconnect wait for the M0-02/M0-03 device runs) · Sources 05 W7–W8, 05 Rec-5, 02 §5.3, D6, D23
Scope: short-code entry screen (12 chars, Crockford, auto-format), XXpsk0 initiator,
fingerprint confirmation screen, key store in IndexedDB (non-extractable `CryptoKey`
where WebCrypto allows, raw static seed otherwise, documented), KK initiator per machine
with re-handshake on every socket, WS client (heartbeat 25 s, backoff 1 → 30 s,
`visibilitychange`/`pageshow`/`online`), snapshot on connect, unacked decision re-send,
polling fallback 15 s, "machine offline — last seen" from relay timestamps.
AC: tests with the harness' in-process relay: pairing completes and the phone decrypts a
frame from the in-process agent; reconnect re-handshakes and receives the pending set.

#### M0-21 — PWA: push subscription, service worker, approval card
Size M · Deps M0-20, M0-12 · Status done 94725e8 (manual locked-iPhone push waits for the M0-02/M0-03 device run; the card's project line waits for repository data in the snapshot) · Sources 05 W4, 05 W9, 05 W14, 05 Rec-1–2, 05 Rec-9, 01 W6, D5
Scope: subscribe with the VAPID public key and register on the relay; `src/sw.ts` with
pure functions `handlePush(data)` / `handleClick(event)` (M0: generic text "Approval
needed on <machine>", **always** `showNotification`, tap → `/requests/:rid`, focus an
open client if any), launch-time pending check, app badge count; approval card:
machine, project, tool label, one-line argument, command hidden until tap, Allow / Deny
(Deny without biometrics, Allow with `assertDecision`), taps within 600 ms of render
ignored, countdown from `expiresAt`, `resolved`/`expired` states, "Reply in terminal"
placeholder (M1-03).
AC: SW pure-function tests under jsdom at 100 %; card tests for every state; manual: a
push arrives on the owner's locked iPhone and the tap lands on the card (logged in the
M0 exit record).

#### M0-22 — Journeys J1–J3, J5–J7 and the privacy gate
Size L · Deps M0-17, M0-21 · Status done f28370c (ubuntu CI + local macOS; Windows run comes with the CI matrix in M0-24) · Sources 07 W10–W11, 01 §1.4, D4
Scope: scenario files J1 pair, J2 allow (real UV assertion via software authenticator),
J3 deny, J5 expiry (FakeClock to `T − 10 s`, agent answers `handoff`, phone sees
`expired`, late decision rejected), J6 agent offline (hook falls through, exit 0 empty),
J7 phone offline (push sink receives metadata payload; phone reconnects and receives the
re-sent request); privacy gate: after each journey, scan relay logs, PGlite dump and
push bodies for every canary; planted-leak meta-test proves the gate catches a leak.
AC: all six journeys green in < 60 s on ubuntu; J1/J2/J5 green on macOS and Windows;
privacy gate green; meta-test red when the plant is active.

#### M0-23 — Real Claude Code verification
Size M · Deps M0-16, M0-21 · Status doing — kit done 331f246 (overhead p95 31.9 ms PASS); real-CLI runs pending owner (claude CLI, trusted temp repo) · Sources 04 W5, 04 W12, 04 A2–A3, 02 §7.2
Scope: not CI. In a temp trusted repo with the real CLI: `claude --bg` with a prompt that
forces a `Bash` permission; the hook held ≥ 11 min and decided from the phone; verify A2
(timeout honoured beyond 600 s) and A3 (terminal shows nothing while held; Ctrl+C
behaviour); measure hook overhead on a 200-tool-call run (p95 target < 150 ms); record
Claude Code version.
AC: `docs/verification/claude-code-hooks.md` with version, timings, outcomes; any
deviation from D10/D11 becomes an ADR before the next WP.

#### M0-24 — Agent: macOS launchd service
Size S · Deps M0-13 · Status done f9d3685 (npx-cache install refuses per ADR 0002) · Sources 06 W13 (macOS part), 06 §5.4, D22
Scope: `remotectl install|uninstall` on macOS: `dev.remotectl.agent.plist` with
`KeepAlive`, `RunAtLoad`, log paths; npx-cache detection → global install first;
`status` reads launchctl state.
AC: `install --dry-run` prints the plist; temp-HOME test installs, verifies idempotency,
uninstalls cleanly (runs in the `agent-os` macOS job from M0-25).

#### M0-25 — CI completion: OS matrix, coverage, pg-real, Dependabot, browser vectors
Size M · Deps M0-22, M0-24 · Status done d1e5ff0 (GitHub runs on macOS/Windows, pg-real on `main` and branch protection pending first push + owner `gh api` step; pg-real green locally on Postgres 17) · Sources 07 W13–W18, 07 W9, 06 W3, 06 W22
Scope: workflows `ci` (ubuntu, PGlite), `agent-os` (ubuntu/macOS/Windows: fake-claude
conformance, hooks install/uninstall/corrupt-JSON, service `--dry-run`, J1/J2/J5),
`pg-real` (`services: postgres`, on `main` + nightly), `e2e` skeleton (label/`main`/
nightly; specs land in M1-12), browser crypto vector spec (Chromium + WebKit on
`main`), coverage thresholds per D18 + honesty test (no `v8 ignore`), Trivy image scan +
`pnpm audit signatures`, Dependabot weekly grouped, branch protection contexts listed in
`docs/ops/runbook.md`.
AC: lowering any threshold fails `ci`; a PR cannot merge without `ci` + `agent-os`;
`pg-real` green on `main`.

#### M0-26 — Operations baseline
Size S · Deps M0-02 · Status doing — code done bb2c9e5; Railway backups + restore drill, UptimeRobot, usage alert, Sentry project + DSN pending owner · Sources 06 W10, 06 W12, 06 W20, 06 §5.5–5.7
Scope: Railway backups on + one restore drill; UptimeRobot on `/health` → e-mail; Railway
usage alert $8 / hard limit $15; Sentry (free) on the relay with payload scrubbing;
`docs/ops/runbook.md` (deploy, rollback, restore, rotate VAPID/agent tokens, cost check).
AC: restore drill logged in the runbook; a forced crash appears in Sentry without any
payload field.

#### M0-27 — SECURITY.md, README v0, supply chain, npm name
Size S · Deps M0-13 · Status doing — repo part done d7964c3; npm placeholder publish pending owner · Sources 02 W1, 02 W13, 01 W1, 06 W16, D13
Scope: `SECURITY.md` (threat model summary from 02 §4, what the relay stores, reporting
channel), README v0 with the positioning and the honest comparison table vs Claude Code
Remote Control (01 §5.1), `pnpm` `minimumReleaseAge`, `files` whitelist, provenance
settings, `remotectl@0.0.1` placeholder published manually (owner's npm account, 2FA).
AC: files exist and are linked; `npm view remotectl` shows 0.0.1 owned by the owner.

**M0 exit record**: `docs/verification/m0-exit.md` — the owner's real approval from
outside home (date, network, device), journeys and gates green (CI run links).

### M1 — Second user

#### M1-01 — AskUserQuestion end-to-end
Size M · Deps M0-22 · Status done 03f06e2 (answers require UV per scope; 01 says no biometric, owner to confirm) · Sources 04 W4, 04 §2.3, 01 W7, 05 W9, 02 W11, D11
Scope: adapter `PreToolUse` mapping for `AskUserQuestion` → `question` (1–4 questions,
2–4 options, `multiSelect`, free-text `response`); `decide` emits `permissionDecision:
allow` + `updatedInput {questions (verbatim), answers, response?}` from exactly one
module; protocol `decision.kind = answer` with UV assertion; PWA question screen (one
question per step, option descriptions, "Other" free text, submit with biometrics);
journey J4.
AC: golden tests reproduce 04 §2.3 output; a test proves `updatedInput` is emitted only
for `AskUserQuestion`; J4 green; argv/policy gate extended to flag `updatedInput` outside
the single module.

#### M1-02 — "Always" from the phone (session scope)
Size S · Deps M1-01 · Status done 4aef90a · Sources 04 W10, 01 Q3, 04 Q5, D24
Scope: `decision.behavior = always` → `updatedPermissions` built from
`permission_suggestions` with `destination: "session"` only; card shows "Always (this
session)" only when `alwaysSupported`; UV assertion required; security note in the
PR body referencing 02 §5.4.
AC: test shows the rule is emitted only with `destination: session` and only when
suggestions exist; J2 variant green.

#### M1-03 — "Reply in terminal", early handoff, `remotectl pause`
Size S · Deps M0-22 · Status done 5b1d670 · Sources 01 W9, 04 §5.8, D10
Scope: phone action "Reply in terminal" (no biometrics) → agent answers the hook with
`handoff` immediately, request `released`, other phones dismiss; `remotectl pause
[--for 2h]` / `resume` makes the receiver answer every blocking hook with `handoff`
instantly while the user is at the desk; `status` shows paused.
AC: journey J5 variant: release from the phone within 1 s; pause test: a held request is
answered immediately with no decision.

#### M1-04 — Session registry, launcher, follow-up
Size L · Deps M0-22, M0-23 · Status doing — code done f25cfea; real-CLI check pending M0-23 (ADR 0005) · Sources 04 W6–W7, 04 §5.3–5.4, 01 W10, 02 W11, 03 §5.6
Scope: `SessionRegistry` fed by hooks + `claude agents --json --all` poll every 10 s
while sessions exist (`kind`, `name`, `state`, `status`, `waitingFor`, `pid`), stale after
24 h; `Launcher`: allow-list + trust canary, `spawn("claude", ["--bg", "--name", name,
prompt], {cwd})`, UUID capture by `name + cwd`, follow-up `claude --resume <uuid> --bg
"<text>"` for `kind: background`, `unsupported` for interactive, version gate ≥ 2.1.257;
protocol `startSession` / `instruction` with UV assertions; journeys J9 instruction,
J10 new session, J11 allow-list refusal (refused before spawn, audit event).
AC: tests with fake-claude assert exact argv and cwd; path outside the allow-list refused
before spawn; symlink into the allow-list refused; J9–J11 green; argv gate green.

#### M1-05 — Live feed and the thin session view
Size L · Deps M1-04 · Status doing — code done d22c187; real-CLI check pending M0-23 (ADR 0005) · Sources 04 W8, 04 §5.5, 05 W10, 05 W12, 01 W11, 01 W10, D21
Scope: `HookEvent` mapping for `UserPromptSubmit`, `PostToolUse` (tool, input, truncated
response; `+N −M` for Edit/Write/MultiEdit from `tool_input`), `Stop`
(`last_assistant_message`), `SubagentStop`, `PreCompact`, `Notification`; size caps
(event ≤ 64 KiB, snapshot ≤ 20 steps); snapshot on handshake; PWA `/sessions` (per
machine, state badge, `waitingFor`), `/sessions/:id` (state, last prompt, ≤ 20 steps,
last answer, changed files — full path on tap, no diff bodies), compose box (follow-up,
disabled with reason for interactive sessions), `/new` repository picker; journey J8.
AC: golden mapping tests; snapshot size test; J8 green; the session screen renders a
fixture session in jsdom with no payload larger than the cap.

#### M1-06 — Encrypted push summary
Size M · Deps M0-22 · Status done 24f60ed (ADR 0001) · Sources 05 Rec-1, 07 W20, 02 §5.2, D5
Scope: notification key = HKDF(DH(statics), `"rc/v1/push"`) derived at pairing on both
ends; agent attaches `push_blob` (AES-256-GCM of `{project, toolLabel, line}` ≤ 1 KiB)
to request headers; relay copies it into the push payload (≤ 3.5 KB); SW imports the
decrypt-only key from IndexedDB, decrypts, titles "<project>: <tool>", falls back to the
generic text on any error, always `showNotification`; one-paragraph ADR
`docs/adr/0001-push-summary-key.md` reviewed against 02 §5.2.
AC: SW tests at 100 % incl. the fallback path; J7 variant asserts the push body is
ciphertext (privacy gate canary); ADR present.

#### M1-07 — Machines screen, "Can't connect?" checklist, onboarding self-test
Size M · Deps M1-05 · Status doing — code done b69ecf3; real-CLI check pending M0-23 (ADR 0007) · Sources 01 W8, 01 W12, 05 Rec-3, 04 §4.1
Scope: `/machines` with presence (last seen from relay timestamps), paired devices,
revoke entry point (M1-10), per-repo hook status ("no hook seen yet — trust the folder
in Claude Code"), checklist (daemon running? relay reachable? repo trusted? hooks
installed?); onboarding self-test: `remotectl status --self-test` fires a fake
`PermissionRequest` through the real hook path so the first notification arrives during
setup.
AC: screen tests; self-test journey green; the checklist text matches `remotectl status`
output (shared strings in `packages/protocol`).

#### M1-08 — Linux and Windows services, `uninstall`, `logs`, `update`
Size M · Deps M0-24 · Status done 53b346e (Linux/Windows real runs pending M0-25) · Sources 06 W13, 06 W17, 06 Q7, D22, I4
Scope: `systemd --user` unit + `loginctl enable-linger`; Windows Task Scheduler ONLOGON
task from XML (`ExecutionTimeLimit PT0S`); `uninstall` for all three; `logs` tail;
notify-only update check (npm dist-tags, once per 24 h, no auto-update); Windows may
slip to M2 (06 Q7).
AC: `agent-os` matrix runs install/uninstall `--dry-run` + idempotency on all three; a
mocked registry test shows the update notice and no download.

#### M1-09 — Release pipeline and first public version
Size S · Deps M0-27, M1-08 · Status doing — code done 43a70c3 (tag-driven, ADR 0003); first tagged publish + checklist pending owner (npm trusted publisher, M0-27 placeholder, push) · Sources 06 W15, 07 W21, 06 §5.3
Scope: release-please manifest, `release.yml` with npm trusted publishing (OIDC,
provenance), `docs/release-checklist.md` (real iPhone push, Face ID, real Claude Code
flow, Railway deploy, fixture refresh), README install section → `remotectl@0.1.0`.
AC: a tagged release publishes with provenance; `npm audit signatures` passes on the
published tarball; checklist executed and ticked in the release PR.

#### M1-10 — Revocation and deletion
Size M · Deps M1-07 · Status done 5c11cfa (built ahead of M1-07's real-CLI check; audit rows purged on deletion, no tombstone, inactive purge deferred — ADR 0009) · Sources 02 W14, 02 §5.9, 01 §5
Scope: revoke a phone (from another phone or `remotectl devices revoke`), revoke a
machine, account deletion (relay rows purged, agent peers dropped on next connect),
pairing re-run after revoke; journey J12.
AC: J12 green: a revoked phone's frames are rejected by the agent and its socket closed
by the relay; deletion leaves no row for the user (schema-wide assertion).

#### M1-11 — Tool-label dictionary, card polish, local stats
Size S · Deps M0-21 · Status done 15e5117 · Sources 01 W4, 01 W6, 01 W13
Scope: `packages/protocol/tool-labels.ts` (Bash → "Run command", Edit → "Edit file", …,
MCP tools by server name), card rules finalised, local counters (approvals, denials,
sessions started, per project) kept on the phone + agent, surfaced on `/machines`.
AC: every Claude Code built-in tool has a label (test enumerates the list); counters
test.

#### M1-12 — Playwright end-to-end
Size M · Deps M0-25, M1-05 · Status done 5286172 (the relay serves the built PWA instead of a dev server; WebKit signs in by the harness passkey's session cookie and W2 pairs and reads a session with WebKit WebCrypto, the known-answer vectors stay in `pnpm test:browser`; first CI run pending the next push) · Sources 07 W12–W13, 05 §6
Scope: `webServer` array (relay on PGlite + web dev server), iPhone emulation, CDP
virtual authenticator, `dispatchPush` into the SW; specs P1 register/login, P2 onboarding
gate, P3 pair, P4 approve with UV, P5 deny, P6 question, P7 push tap routing, P8 sessions,
P9 new session; WebKit smoke W1 (install prompt + probe), W2 (crypto vectors).
AC: all specs green < 5 min with 2 workers on `main`; report artifact uploaded; `e2e`
label runs them on a PR.

#### M1-13 — Audit log and admin counters
Size S · Deps M0-10 · Status done 5363b77 (device revoke rows land with M1-10) · Sources 03 W12, 02 §5.6
Scope: `audit_log` writes for pair, revoke, login, decision-forwarded (hash only),
push-sent; `GET /api/admin/counters` (owner only: users, devices, online agents, pushes
per day) — no bodies anywhere.
AC: privacy gate scans the audit table; counters test.

#### M1-14 — README positioning, screens doc, second-user run
Size S · Deps M1-09 · Status todo · Sources 01 W1, 01 W3, 01 W14, 01 §1.6
Scope: README final comparison table, quick start, `docs/product/screens.md` final; the
owner runs the second-user protocol (01 W14) with the named second user (§6 Q13) and
logs timings/blockers.
AC: `docs/verification/second-user.md` ≤ 10 min without help, or a list of fixes
turned into WPs.

#### M1-15 — Soak and load smoke
Size S · Deps M1-12 · Status doing — code done 287eb9c (soak harness, `pnpm soak`, CI smoke per OS); 24 h run pending owner · Sources 03 W14, 07 W15
Scope: 24 h soak of the real agent + relay with fake-claude firing every minute (memory,
reconnects, no duplicate decisions); CI `continue-on-error` service load smoke per OS.
AC: soak log in `docs/verification/soak.md` with RSS flat and zero duplicate decisions.

**M1 exit record**: `docs/verification/m1-usage.md` — two weeks, ≥ 20 approvals from
outside home, hangs = 0; second-user log; release checklist link.

### M2 — Beyond Claude Code

#### M2-01 — Codex CLI adapter
Size M · Deps M1-05 · Status done 8246841 (real-CLI log pending, ADR 0008) · Sources 04 W13, 04 §2.11, 04 §5.9, D12
Scope: `~/.codex/hooks.json` writer (`PermissionRequest`, `PreToolUse`, `PostToolUse`,
`UserPromptSubmit`, `Stop`, `SessionStart/End`, timeout 1800), `hook.js --adapter codex`,
decision mapping, `/hooks` trust instruction + `SessionStart` canary in `status`,
capability flags (`questionsSupported: false`, follow-up unverified → `unsupported`),
fake-codex scenarios in `packages/fake-claude-code` (rename to `fake-agents` if cleaner).
AC: golden tests on 04 §2.11 shapes; journey J2/J3 variant with fake-codex; manual log
`docs/verification/codex.md` with the real CLI.

#### M2-02 — Diff viewer
Size M · Deps M1-05 · Status done 51e6a0f · Sources 05 W11, 01 M2, D21
Scope: unified diffs from `PostToolUse` Edit/Write payloads (`diff` package `parsePatch`),
hunk collapse, large-file cap, horizontal scroll, mono font; opt-in per request from the
session screen (diff bodies are fetched from the agent on demand, not pushed).
AC: renders the fixture diffs; cap test; no diff body in any push payload (privacy gate).

#### M2-03 — Agent-side assertion verification (phase 2)
Size M · Deps M1-10 · Status done c506f5e (legacy peers keep relay trust; no passkey-add flow, re-pair instead — ADR 0010) · Sources 02 W15, 02 §5.4, D7
Scope: passkey SPKI shared with the agent at pairing (and on passkey add), the WebAuthn
assertion carried inside the encrypted decision, agent verifies ES256 signature, `rpIdHash`,
UV flag, counter; relay verification kept as defence in depth.
AC: J2 passes with the relay's `verified` flag removed; tamper tests.

#### M2-04 — QR pairing (optional input)
Size S · Deps M0-20 · Status done 2c04c2d (manual iOS/Android check pending) · Sources 05 W15, 02 §5.3, D6
Scope: `barcode-detector` ponyfill behind the camera permission, full 32-byte token from
the `rc1:` QR; short code stays available.
AC: unit test decodes the fixture QR text; manual check on iOS and Android logged.

#### M2-05 — Desktop two-pane layout
Size S · Deps M1-05 · Status done d89d89a · Sources 05 W16, 05 Rec-10
Scope: ≥ 900 px: sessions list left, detail right; keyboard shortcuts for Allow/Deny
(still with UV).
AC: layout test at 1280 px; Playwright desktop project added.

#### M2-06 — History and cost per project
Size M · Deps M1-11 · Status done e005244 (token/cost not counted: the `Stop` hook payload carries no usage; duration is turn time UserPromptSubmit→Stop) · Sources 01 §1.2 (f), 01 W13
Scope: agent keeps per-project counters (sessions, tool calls, approvals, duration;
token/cost when `Stop` payloads expose usage) locally; phone shows history per
repository; nothing stored on the relay.
AC: counters survive agent restart (local file); privacy gate unchanged.

#### M2-07 — "Always" with settings destinations
Size S · Deps M1-02 · Status done 8671465 (destination signed in the always payload; null = session) · Sources D24, 04 Q5
Scope: agent setting `always.destinations: ["session"]` extendable to `localSettings` /
`projectSettings`; phone offers the choice only when enabled.
AC: test shows a destination outside the setting is never emitted.

#### M2-08 — Optional notifications on turn finished / needs input
Size S · Deps M1-06 · Status done 5abb8b9 (setting lives in the per-machine agent config, default off) · Sources 01 Q5, 04 §2.4
Scope: per-user setting (default off) to push on `Stop` and `agent_needs_input`
notifications with the encrypted summary.
AC: setting off → no push (test); on → push body is ciphertext.

#### M2-09 — Bounded `--permission-mode` for phone-started sessions
Size S · Deps M1-04 · Status done c0bac79 (real-CLI check pending M0-23; ADR 0006) · Sources 04 W10, 04 §5.4
Scope: per-repo `maxPermissionMode` in agent config; phone picker limited to it; argv
module extended by one literal flag; gate updated.
AC: argv test; a mode above the bound is refused before spawn.

### M3 — Backlog (unsized, not planned)
Gemini CLI observe+deny adapter (04 W14); `claude-sdk` adapter for API-key users (04 W15);
transcript backfill via the agenthropic parser behind a flag (04 W11, 07 W5);
`PgNotifyHub` + 2 replicas (03 W11); Node 24 image + CI (06 W21); staging environment
(06 §5.6); interactive pty fake (07 W22 — only if a pty route is ever chosen); native
wrappers (01-roles).

## 5. Conventions for the executor

- **Layout** is D2. `src/core` never imports Fastify, `ws`, `pg`, React or `node:*`
  beyond types; adapters do. Each app has `container.ts` wiring ports to adapters
  (`HubPort`, `PushPort`, `Db`, `Clock`, `Random`, `AgentAdapter`, `RelayClientPort`,
  `KeyStore`).
- **Names.** npm `remotectl`; protocol id `rc/v1`; QR prefix `rc1:`; enrolment token
  prefix `rc-enroll:`; launchd label `dev.remotectl.agent`; loopback port 4327; env vars
  `RC_*` on the relay (`RC_DATABASE_URL` falls back to Railway's `DATABASE_URL`,
  `RC_VAPID_PUBLIC/PRIVATE`, `RC_RP_ID`, `RC_ORIGIN`, `RC_SENTRY_DSN`); Postgres tables
  snake_case; TypeScript camelCase; files kebab-case; one exported thing per module in
  `core`.
- **Docs locations.** `docs/analysis/` (this corpus, frozen after ratification; edits
  only to §4 status, §6 answers, §7); `docs/adr/NNNN-<slug>.md`; `docs/verification/`
  (manual logs, one file per WP that asks for one); `docs/product/screens.md`;
  `docs/ops/runbook.md`; `docs/release-checklist.md`; `SECURITY.md`; README.
- **Commits.** Imperative subject ≤ 72 chars prefixed with the WP id (`M0-05: protocol
  v1 schemas and state machine`); body lists `AC:` and the `D` numbers implemented; no
  attribution trailers of any kind; harness files never staged. Several commits per WP
  are fine when each leaves `pnpm check` green.
- **Tests.** vitest; file next to the code as `*.test.ts`; journeys in
  `packages/test-harness/journeys/J<nn>-<slug>.test.ts`; golden fixtures as JSON under
  `fixtures/` with canary strings; no real network, no real time, no `Math.random` in
  tests or core (lint enforces); property tests via `fast-check`.
- **Versions.** Pin exact versions in `package.json` for runtime deps; `^` for dev
  deps; `pnpm-lock.yaml` committed; `minimumReleaseAge` 7 days.
- **Stop conditions.** Stop and ask the owner when: a device-spike capability is NO-GO;
  a real-CLI verification contradicts D10/D11; a WP needs a dependency with network
  access at runtime in the agent; a change would put a payload column in Postgres; a
  decision in §2 turns out to be wrong in practice.

## 6. Owner decisions (consolidated)

Defaults apply until the owner answers; the executor records answers here in the
`Answer` column (one commit, `docs/analysis/ROADMAP.md` only). Source questions are the
specialists' §8 items this row replaces.

| # | Decision | Default | Replaces |
|---|---|---|---|
| Q1 | Proceed despite the overlap with Claude Code Remote Control, with the kill criterion from §1 | **Proceed** | 01 Q1 |
| Q2 | Production domain: buy now, name? Attached to Railway before M0-03 | **Buy now**; owner picks the name | 06 Q2, 05 Q2 |
| Q3 | Hold time for a pending approval and what happens at the deadline | **30 min, then handoff to the terminal prompt**; `onExpire: deny` opt-in | 04 Q1–Q2, 03 Q1–Q2, 01 W9 |
| Q4 | Accounts: passkeys only, no e-mail, invite codes at launch, one recovery code, cookie 7 d idle / 30 d absolute | **Yes to all** | 02 Q1, Q5, Q6; 03 Q5 |
| Q5 | Biometric (UV) on every Allow / Always / Answer / Instruct / Start, none on Deny, no reuse window | **Yes** | 01 Q4, 02 Q3–Q4, 05 Q4 |
| Q6 | Platform floor iOS 17+ / Chrome Android ≥ 133; no polyfill for older | **Yes** | 05 Q1 |
| Q7 | "Always" from the phone in M1 with session scope only; settings scopes in M2 | **Yes** | 01 Q3, 04 Q5 |
| Q8 | Pairing: 12-char typed code primary, QR in M2, 32-byte token in the QR | **Yes** | 05 Q5, 02 §5.3 |
| Q9 | Second agent = Codex (M2), Gemini observe+deny in backlog | **Codex** | 01 Q2, 04 Q6 |
| Q10 | Notifications carry a real encrypted summary from M1 (generic text in M0) | **Yes** | 05 Q3 |
| Q11 | Sessions via `claude --bg` only; no `-p`/SDK child on the subscription; follow-up to foreground sessions `unsupported` | **Yes** | 04 Q3–Q4 |
| Q12 | Railway Hobby, Amsterdam, Sentry free on relay, UptimeRobot e-mail, usage alert $8 / limit $15, no Discord | **Yes** | 06 Q3–Q5, Q9; 03 Q4 |
| Q13 | A named second user exists before M1 starts (for the usability run) | **Owner names one** | 01 Q10 |
| Q14 | All three OS installers in M1, Windows allowed to slip to M2 | **Yes** | 06 Q7 |
| Q15 | npm: name `remotectl`, publish from the owner's existing npm account with 2FA, trusted publishing | **Yes** | 06 Q1, Q8 |
| Q16 | Agent key storage: plain files at 0600 in the env-paths data dir (no OS keychain in MVP) | **Yes** | 02 Q7 |
| Q17 | Device cap 10 per user; multi-machine from M0; allow-list editable only in the agent config file | **Yes** | 03 Q6, 01 Q7–Q8 |
| Q18 | Phone-started session with an unanswered request behaves like a terminal one (stays in "Needs input" after handoff) | **Yes** | 01 Q9 |
| Q19 | Push on turn finished / needs input: off by default, setting in M2 | **Off** | 01 Q5 |
| Q20 | QA gates: thresholds enforced, OS matrix on every PR, Playwright on `main`/nightly/label, `pg-real` nightly + `main`, anonymised fixtures committed, WebKit smoke on | **Yes** | 07 Q1–Q7 |
| Q21 | Relay supports current + previous protocol major; agent ships its version in `hello` | **Yes** | 03 Q7 |

Decisions the roadmap took without an owner question (listed for visibility): no outbox
(D4), no `@noble` fallback (D3), tsdown over tsup, `drainingSeconds` 30, env-paths over
`~/.config/remote-control`, `remotectl` over `remote-control-agent`, hook `onFailure`
unset (D10), port 4327.

## 7. Risk register (consolidated)

| # | Risk | L | I | Mitigation / owner WP |
|---|---|---|---|---|
| R1 | iOS push or UV in the installed PWA fails on the owner's device | low | fatal | M0-03 spike before any PWA work; NO-GO → native wrapper decision |
| R2 | Anthropic ships Always-from-phone + non-Claude agents in Remote Control before M1 | medium | high | Kill criterion (§1); M0 kept small; README honest from day one (M0-27) |
| R3 | Background sessions (research preview) change flags or semantics | medium | high | Version gate + `claude agents --json` feature detection (M1-04); fake-claude isolates the surface; `-p` child fallback documented, not built |
| R4 | Hook timeout silently capped / terminal behaviour differs from A2–A3 | low | medium | M0-23 real-CLI verification before M1; ADR on deviation |
| R5 | Repo not trusted in Claude Code → silent no-hooks | high (first use) | medium | Installer message, `status` canary, phone hint (M0-14, M1-07) |
| R6 | WebAuthn RP ID bound to a temporary domain | medium | high | D9: domain before the first passkey (M0-02 → M0-03) |
| R7 | Relay compromise forwards a forged decision | low | critical | E2E KK + request-bound UV assertion (M0-16, M0-19); agent-side verification M2-03 |
| R8 | Local malware posts fake hooks or decisions | low | high | Loopback + 0600 token + no decide route (M0-14); decisions only via the relay channel |
| R9 | Payload or transcript leaks into relay logs / DB / push | medium | high | Privacy gate + canaries + schema assertion (M0-08, M0-22); redaction (M0-04) |
| R10 | Shorter pairing code brute-forced | low | high | 60-bit code, single-use 5-min slot, 3-attempt abort, fingerprint confirm (M0-16, M0-20); sign-off at WP time |
| R11 | Decision stuck → Claude Code hangs or user at desk blocked | medium | medium | Handoff at `T − 10 s`, "Reply in terminal", `remotectl pause` (M1-03) |
| R12 | Agent dies / npx cache path / not restarted after reboot | medium | medium | launchd/systemd/Task Scheduler with KeepAlive (M0-24, M1-08); `status` |
| R13 | Supply-chain compromise of `remotectl` | low | critical | Trusted publishing + provenance, zero runtime deps, `minimumReleaseAge`, no auto-update (M0-27, M1-09) |
| R14 | Railway single replica restarts → all sockets drop | certain, rare | low | Reconnect + re-handshake + pending re-send (D4); drain 1012 (M0-10) |
| R15 | Transcript format change breaks anything that parses it | high over time | low | Hooks are the only source (D11); backfill stays M3 behind a flag |
| R16 | Hook overhead slows Claude Code | certain | low | 5 s budget, fire-and-forget feed hooks; p95 < 150 ms measured (M0-23) |
| R17 | Two phones / Remote Control race on one request | low | low | First decision wins + `resolved`; after handoff the agent never decides (M0-16) |
| R18 | Hobby cost creep | low | low | Usage alert + hard limit (M0-26) |
| R19 | Executor context overflow reading the corpus | medium | medium | §0 read rules; reports cited by section; WP scopes self-contained |

## 8. Appendix — report work items → work packages

Every specialist work item is mapped; "dropped" entries say why. The executor uses this
table to check that nothing was lost when a WP is finished.

**01 Product**: W1 README positioning → M0-27, M1-14 · W2 vocabulary → M0-05 · W3 screens
doc → M0-18, M1-14 · W4 tool labels → M1-11 · W5 lifecycle state machine → M0-05 ·
W6 card rules → M0-21, M1-11 · W7 question screen → M1-01 · W8 onboarding + self-test →
M0-14, M0-18, M1-07 · W9 reply in terminal + hold policy → M1-03, D10 · W10 new session →
M1-04, M1-05 · W11 thin session view → M1-05 · W12 machine screen + checklist → M1-07 ·
W13 local stats → M1-11, M2-06 · W14 second-user protocol → M1-14.

**02 Security**: W1 SECURITY.md → M0-27 · W2 strict schemas + canonical decision → M0-05 ·
W3 WebCrypto wrapper → M0-06 (noble fallback dropped, D3) · W4 Noise engine → M0-06 ·
W5 transport session + properties → M0-06 · W6 pairing → M0-11, M0-16, M0-20 · W7
passkeys → M0-09, M0-19 · W8 decision binding + assertion → M0-05, M0-11, M0-16, M0-19 ·
W9 redaction + canary → M0-04, M0-22 · W10 tenant routing / limits / invites → M0-09,
M0-10 · W11 argv gate → M0-13, M1-01 · W12 agent hardening → M0-13, M0-14 · W13 supply
chain → M0-27, M1-09 · W14 revocation/deletion → M1-10 · W15 agent-side assertion →
M2-03.

**03 Backend**: W1 scaffold → M0-01 · W2 protocol → M0-05 · W3 relay skeleton → M0-02 ·
W4 schema + migrator → M0-08 · W5 WS/auth/hub/presence → M0-09, M0-10 · W6 heartbeats/
limits → M0-10 · **W7 outbox → dropped (D4)**; replaced by pending re-send in M0-16 and
M0-20 · W8 shutdown → M0-10 · W9 push → M0-12 · W10 agent core → M0-13, M0-14, M0-16 ·
W11 PgNotifyHub → M3 · W12 audit + counters → M1-13 · W13 Dockerfile/Railway → M0-02 ·
W14 soak → M1-15.

**04 Agent integration**: W1 hook.js → M0-14 · W2 receiver + pending store → M0-14 · W3
installer → M0-14 · W4 adapter decide → M0-15, M1-01 · W5 real-CLI test → M0-23 · W6
registry → M0-15, M1-04 · W7 launcher → M1-04 · W8 feed mapping → M1-05 · W9 relay client
→ M0-16 · W10 permission-mode + always → M1-02, M2-09 · W11 transcript tailer → M3 · W12
overhead measurement → M0-23 · W13 Codex → M2-01 · W14 Gemini → M3 · W15 SDK adapter →
M3.

**05 PWA**: W1 spike → M0-03 · W2 scaffold → M0-18 · W3 probe + gate → M0-18 · W4 push +
SW → M0-21, M1-06 · W5 passkeys → M0-19 · W6 per-action assertion → M0-19 · W7 key store +
pairing → M0-20 · W8 realtime → M0-20 · W9 card + question → M0-21, M1-01 · W10 sessions
→ M1-05 · W11 diff viewer → M2-02 · W12 compose + picker → M1-05 · W13 theming → M0-18 ·
W14 badge → M0-21 · W15 QR → M2-04 · W16 desktop → M2-05.

**06 Platform**: W1 root tooling → M0-01 · W2 CI → M0-01, M0-25 · W3 image scan + audit →
M0-25 · W4 compose + env example → M0-02 · W5 Dockerfile → M0-02 · W6 Railway + IaC →
M0-02 · W7 health → M0-02 · W8 shutdown → M0-10 · W9 migrations pre-deploy → M0-08 · W10
backups → M0-26 · W11 logging → M0-04 · W12 alerts → M0-26 · W13 install/uninstall/status
→ M0-24, M1-08 · W14 build + metadata → M0-13 · W15 release automation → M1-09 · W16 name
reservation → M0-27 · W17 update check → M1-08 · W18 agent logs → M0-13 · W19 local
HTTPS → M0-02 · W20 runbook → M0-26 · W21 Node 24 → M3 · W22 Dependabot → M0-25.

**07 QA**: W1 vitest projects → M0-01 · W2 Clock/Random + lint → M0-01, M0-05 · W3 fake
Claude Code → M0-07 · W4 recorder + anonymiser → M0-07 · W5 transcript builder → M3 (with
backfill) · W6 harness → M0-17 · W7 protocol contract tests → M0-05 (outbox replay
property dropped with D4; replaced by pending re-send property in M0-22) · W8 crypto
tests → M0-06 · W9 browser vectors → M0-06, M0-25 · W10 journeys → M0-22 (J1–J3, J5–J7),
M1-01 (J4), M1-04 (J9–J11), M1-05 (J8), M1-10 (J12) · W11 privacy gate → M0-22 · W12
Playwright setup + P1–P3 → M1-12 · W13 P4–P9 + WebKit → M1-12 · W14 agent-os matrix →
M0-25 · W15 load smoke → M1-15 · W16 workflows → M0-25 · W17 coverage → M0-25 · W18
pg-real → M0-25 · W19 fake push → M0-12, M0-17 · W20 SW tests → M0-21, M1-06 · W21
release checklist → M1-09 · W22 pty fake → M3 (conditional, route not chosen).
