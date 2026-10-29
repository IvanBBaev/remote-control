# As-built review — 09. Product & UX (2026-10-29)

Role 09, area code `UX`. Scope: what a stranger (the M1 second user of
`docs/verification/second-user.md`, run per `docs/product/usability-protocol.md`) actually
meets in the shipped code and copy: README, install path, CLI messages, account and
passkey, enrolment and pairing, first approval, notifications, empty/error/offline
states, revocation and deletion, the native app against the PWA, and terminology.
Positioning is out of scope (V3-P06, V2-P03).

## 1. Summary

- **M1 release (PWA + `remotectl@0.1.0`): ready-with-fixes.** The PWA journey is complete
  and its copy is mostly clear, but the phone tells the user to run `npx remotectl …`
  (contradicting ADR 0002 and README L112), and `remotectl login` cannot succeed until the
  user hand-writes the relay URL into `config.json`, which no screen or command supplies.
  Both sit squarely on the usability protocol's T1→T3 ≤ 10 min pass criterion.
- **Native app on TestFlight (M4-08): not ready.** A release build has no way to sign in,
  create an account, enrol a computer, revoke a phone or delete the account; the only
  connect path is `__DEV__`-only. It opens on sample data whose banner dead-ends. M4 exit
  criterion (2) — a real request allowed on a TestFlight iPhone — is unreachable, and no
  ROADMAP/v2/v3 item covers native sign-in.
- Findings: 1 critical, 2 high, 6 medium, 4 low. Work items: 11.

## 2. Verified facts

Install path and README
- README L57-60: not on npm; from source `node apps/agent/dist/cli.mjs`.
- README L76-78: `npm install -g remotectl@0.1.0`, then `remotectl status  # prints the
  config file path`; L80-88: the user creates `config.json` by hand with `relay.url` and
  `repositories`; L93-97: `login`, `hooks install`, `install`, `pair`; L112: "Install it
  globally, not through `npx`" (ADR 0002).
- README L7-11 status note: pre-release, not verified on real phones or real CLI; no word
  on the native app. L16 diagram and L25 "The phone is a PWA". L44 feature table lists
  Codex but not Gemini. L158-171 repository layout omits `apps/mobile` and
  `packages/phone-core`.

CLI (`apps/agent/src/cli/main.ts`)
- L80-111 `HELP_TEXT`: `hooks install` without `--agent codex|gemini` (README L94 has it);
  no command creates a config.
- L226-233: only `run` writes a default config ("Wrote a default config to …").
- L527-528: `status` with no config prints "(missing; `remotectl run` writes a default)".
- L779-787 `relayUrl()`: `remotectl: no relay configured; set "relay": { "url": … } in
  <path>` — `login` and `pair` both stop here first.
- L796-826 `loginCommand`: failure prints `the relay refused the token (${rotated.error})`
  (raw code); success prints "Logged in; relay credentials stored. Run `remotectl pair`
  next." — `hooks install` and `install` are not mentioned.
- L852: "not logged in; run `remotectl login` first".
- L861-866: `pair` sends `agentName: c.hostname`.
- L945: `devices` with none prints "No paired devices." ("devices" = phones).
- L462-465: "the relay revoked this machine". L609-654: self-test hint "no answer from a
  phone. Is a phone paired and online?". L957-976: trust/Codex/Gemini hints.
- `apps/agent/src/core/pairing.ts:208-212`: `pair` draws the `rc1:` QR, prints the QR
  text and "Scan the QR or enter the code on the phone within 5 minutes."

PWA (`apps/web/src`)
- `screens/pairing.tsx:50-61`: step "1. Sign the computer in" asks a "Computer name";
  L72 `<pre className="command">npx remotectl login {token}</pre>` with no copy control;
  L156 `npx remotectl pair`; L159 "Then scan the QR code it shows, or enter the code.";
  L281 "Run `npx remotectl pair` again"; L41 "Could not create the login command. Try
  again."; L246 "The codes match". No relay URL is shown anywhere.
- Token shape: `rc-enroll:` + 43 base64url chars (`apps/relay/src/core/pairing-service.ts`
  L23-24, L95, L251; 32 bytes).
- `packages/phone-core/src/realtime/phone.ts` L184, L189, L198, L354: "Run `npx remotectl
  pair` again"; L488 "Scan the one `remotectl pair` shows."; L481 "Enter all 12
  characters of the code."
- `screens/auth.tsx` L15-34: offline / rate-limited / invalid invite / unknown passkey
  copy is specific and actionable; L132 recovery code gate ("I saved it", D8).
- `screens/onboarding.tsx` L14-29 update-browser floor; L32-60 install (iOS required);
  L63-96 notifications incl. denied/unsupported states.
- `screens/main.tsx` L32-34 "Computers" / "No computers yet."; L139-180 two-tap
  "Revoke"; L188-240 delete account with offline text "Nothing was deleted."; L281 "No
  sessions yet. Start one here or run an agent on a paired computer."
- `sw.ts` L36 `GENERIC_TITLE = 'Approval needed'`, L74 "… on ${dev}", L76/L135 "Tap to
  review.", L125 "Tap to open." — metadata-only fallback per D5.
- `routes.tsx` L56-114: /login, /onboarding/{update-browser,passkey,install,
  notifications,pair}, /machines, /sessions, /sessions/:id, /requests/:id, /new.

Native app (`apps/mobile`)
- `src/app/(tabs)/settings.tsx` L104: without a phone the row reads "Pair a machine" /
  "Connect first"; L166-218 `DeveloperRelay` ("Developer sign-in until the app has its
  own account sign-in", localhost relay, token from `pnpm dev:session`); **L253
  `{__DEV__ && <DeveloperRelay />}`**; L256 "Live Activity & Dynamic Island" value "M4-06";
  L259 "Face ID before Allow" "On" (static); L110-114 Alert "Pair with X?" / "Codes
  match"; L122 `String(error)`; L70-74 QR is "the future QR code".
- `src/state/store.ts` L47-48 starts on `fixtureInbox` (`sample: true`); L56 decisions on
  sample data mutate fixtures; L116-130 disconnect returns to sample agents.
- `src/ui/screen.tsx` L33-38: "Sample data — pair a machine to see your agents."
- `src/core/authorize.ts` L83-84: `deleteAccountWithoutPasskey` always returns cancelled.
- `src/core/fixtures.ts`: fake "MacBook Pro / billing-api" sessions.
- `app.json`: version `0.0.0`; `NSFaceIDUsageDescription` present, no
  `NSCameraUsageDescription`; `expo-notifications` mode `development`.
- Tabs: Agents / History / Settings (PWA: Sessions / Computers).

Docs and plan
- `docs/product/screens.md` L31: pair screen shows `npx remotectl login <token>` /
  `npx remotectl pair`; L92 and L127 tap guard 600 ms, L293 700 ms; L325-334 Inbox and
  Settings "Not in 0.1.0"; no native screens documented.
- `docs/product/usability-protocol.md` L11-14 participant gets invite link + README; L32
  pass = T1→T3 ≤ 10 min unaided; L44-48 known friction: relay URL typed into
  `config.json` (no command writes it), allow-list by hand, folder trust.
- `docs/verification/second-user.md`: pending owner (Q13, M0-02b, M1-09b).
- ROADMAP L1146-1150 M4-08 scope: archive, associated domains, APNs prod, TestFlight —
  no sign-in. ROADMAP L533 M4 exit (2): a real TestFlight iPhone allows one real request.
  ADR 0017 L68 and L96: the user still signs in with a passkey via the native API;
  Q2 blocks native sign-in. `ROADMAP-v3.md` has no native iOS sign-in item (L67 Android
  passkeys only, gated).
- `00-state.md` §4: no production, no device run, no real CLI, nothing on npm, no second
  user.

## 3. Assumptions

- A1. The second user follows the phone's instructions when they conflict with the
  README, because the phone is where the flow starts (protocol L11-14: invite link first).
- A2. Phone→computer transfer of the 53-char token is by retyping or a user-chosen side
  channel (AirDrop, notes sync); the PWA has no share/copy action.
- A3. `npx remotectl login …` works once (npx downloads and runs), but later
  `npx remotectl install` refuses per ADR 0002, so a stranger meets the refusal halfway.
  Not run here (read-only; nothing is on npm).
- A4. App Store Connect requires a privacy policy URL for external TestFlight and App
  Store; internal TestFlight (owner only, M4-08) does not. Account-creating apps must
  offer in-app deletion (guideline 5.1.1(v)) — only relevant once the native app creates
  accounts.
- A5. Simulator screenshots (M4-01…M4-07) were taken in `__DEV__` builds; nobody has
  seen a release-config build.

## 4. Findings

### F1 — Native release build has no account, enrolment, revoke or delete path (critical, TestFlight)
Evidence: `settings.tsx:253` gates the only connect UI on `__DEV__`; `store.ts:47-48`
and `screen.tsx:33-38` start on sample data with a "pair a machine" banner whose target
needs Connect; `authorize.ts:83-84` delete always cancelled; QR is "future"
(`settings.tsx:70-74`), no camera usage string in `app.json`. M4-08 scope (ROADMAP
L1146-1150) and v3 contain no native sign-in.
Why it matters: on TestFlight the app is a demo with fake "MacBook Pro" sessions; M4 exit
criterion (2) cannot be met; the owner will discover this only after paying for the
Apple Developer Program (Q22). An app that later creates accounts needs in-app deletion.
Touches: ADR 0017 (passkey sign-in), D7, M4-08, M4 exit (2), Q2, Q22, R1.

### F2 — The phone tells strangers to use `npx`, which the product forbids (high, M1)
Evidence: `pairing.tsx:72,156,281`; `phone.ts:184,189,198,354`; `screens.md:31` vs README
L112 and ADR 0002.
Why it matters: the second user starts on the phone (A1); `npx` defeats the global
install that `install` (launchd/systemd) requires, so the stranger hits ADR 0002's refusal
mid-flow or ends with no daemon. Directly threatens the ≤ 10 min pass (protocol L32).
Touches: ADR 0002, R12, M1-14b.

### F3 — `remotectl login` cannot succeed from the phone's instructions alone (high, M1)
Evidence: `main.ts:779-787` stops `login` with "no relay configured"; only `run` writes a
default config (`main.ts:226-233`); `status` does not (`main.ts:527-528`); the phone never
shows the relay URL; README L76-88 asks for a hand-written JSON file; protocol L44-48
lists it as known friction with no work item.
Why it matters: the first command the phone gives fails; recovery needs the README, a
path lookup and hand-edited JSON with an exact URL. The pairing QR already carries the
relay host (`pairing.ts:208`), so the information exists on the phone side.
Touches: M1-14b, usability protocol T2, D6.

### F4 — The enrolment token must be retyped from phone to computer (medium, M1)
Evidence: `pairing.tsx:72` plain `<pre>`; token 53 chars of base64url
(`pairing-service.ts:23-24,95,251`); no copy/share action.
Why it matters: case-sensitive base64url (`-`, `_`, `l`/`1`, `O`/`0`) typed by hand is
the slowest and most error-prone step; a typo yields a raw relay error code (F11).
Touches: protocol L32, D6.

### F5 — CLI points to the next step but skips hooks and the daemon (medium, M1)
Evidence: `main.ts:796-826` success line "Run `remotectl pair` next."; README L93-97 order
is login → hooks install → install → pair; the phone's step 2 is `pair`.
Why it matters: a user who follows the terminal pairs successfully, sees the machine on
the phone, then never gets a request (no hooks, no daemon) — the silent-no-hooks failure
R5 describes, reached by our own copy. `status --self-test` exists but is not suggested.
Touches: R5, R12, M0-14, M1-07.

### F6 — Terminology drifts across CLI, PWA, app and docs (medium)
Evidence: the computer running `remotectl` is "computer" (PWA `main.tsx:32`,
`pairing.tsx:50-54`), "machine" (`/machines` route, app "Machines"/"Pair a machine",
`settings.tsx:104`, CLI `main.ts:462`, `screen.tsx:33`); phones are "devices" (CLI
`devices`, `main.ts:945`); session list is "Sessions" (PWA) vs "Agents" (app); "The codes
match" (PWA L246) vs "Codes match" (app L110-114).
Why it matters: "devices" means phones in the CLI but reads as computers to a stranger
reading "revoke this device"; mismatched labels make the PWA-vs-app support story and the
usability protocol's task wording ambiguous.
Touches: ROADMAP appendix 01 W2 (vocabulary → M0-05) — the vocabulary exists but the
native app and CLI did not adopt it.

### F7 — Release-build polish leaks internals (medium, TestFlight)
Evidence: `settings.tsx:256` shows "M4-06"; L259 "Face ID before Allow: On" is static
text, not state; L122 `String(error)`; `app.json` version `0.0.0`; sample-data decisions
mutate fixtures (`store.ts:56`).
Why it matters: an internal WP id and a fake toggle undermine trust in a security
product whose pitch is "you decide"; a static "On" is a security claim not backed by code.
Touches: D7, I4 (perceived), M4-08.

### F8 — README is silent on the native app and overstates "about ten minutes" (medium)
Evidence: README L7-11 status note (PWA only), L16/L25 "phone (PWA)", L158-171 layout
without `apps/mobile` / `packages/phone-core`; Quick start "about ten minutes" while the
second-user run is pending (`second-user.md`, `00-state.md` §4).
Why it matters: honesty is a stated R2 mitigation ("README honest from day one"); the
time claim is exactly what M1-14b measures. Positioning itself is V3-P06 — this finding
is only about the status note and the layout facts.
Touches: R2, M0-27, V3-P06 (evidence lane owns README).

### F9 — Privacy policy needed before external TestFlight / App Store (medium, gated)
Evidence: no privacy policy or terms in `docs/` or README (grep); A4.
Why it matters: not needed for M4-08 (internal). Needed the moment the build goes to an
external tester or the store (V3-C11 pipeline). The content is short because the product
holds no e-mail, telemetry or payloads (01-roles.md L28), but it needs a public URL —
on the Q2 domain.
Touches: Q2, V3-C11, M4-08 follow-on.

### F10 — `remotectl status` copy implies it creates the file (low)
Evidence: README L77 "prints the config file path", then L80 "create it"; `main.ts:527-528`
says `run` writes a default. Three different bootstrap stories.
Touches: superseded if RV-UX-02 lands.

### F11 — Raw error codes reach the user (low)
Evidence: `main.ts:796-826` `the relay refused the token (${rotated.error})`; app
`settings.tsx:122` `String(error)`. PWA copy (`auth.tsx:15-34`, `main.tsx:188-190`) shows
the right pattern (mapped, actionable).
Touches: none beyond UX.

### F12 — Computer name entered on the phone is discarded at pair time (low)
Evidence: phone asks "Computer name" (`pairing.tsx:54-61`, relay stores `name`,
`pairing-service.ts:65-89`); `pair` sends `agentName: c.hostname` (`main.ts:866`).
Why it matters: the user names it "Work laptop", then sees `ivans-mbp.local` on the
Computers screen and in notification titles (`sw.ts:74`).
Touches: D5 (`dev` in push metadata).

### F13 — Docs drift (low)
Evidence: `screens.md` tap guard 600 ms (L92, L127) vs 700 ms (L293); `HELP_TEXT`
(`main.ts:80-111`) lacks `--agent`; README L44 omits Gemini (observe-and-deny ships);
`screens.md` documents no native screens.
Touches: M1-14 (screens doc), V2-P03.

Strengths worth keeping (no action): passkey/auth error copy is specific and
offline-aware; recovery-code gate; update-browser floor names the exact versions; two-tap
revoke and "Nothing was deleted." on offline delete; notification fallback is generic and
metadata-only (D5); pairing errors are human ("Enter all 12 characters of the code.");
the CLI prints both QR and code with the 5-minute window.

## 5. Recommendations

R1 (F1). Add a native account path before M4-08, as its own WP that M4-08 depends on:
passkey sign-in and registration with the invite code via the iOS passkey API on the Q2
RP ID (associated domains), recovery-code screen, enrol-a-computer (shows the same
command as the PWA), revoke phone, delete account with passkey. Release builds start on
an empty "Sign in" state, never on fixtures.
Rejected: (a) ship TestFlight with the dev token flow — needs `pnpm dev:session` and a
localhost relay, useless on a device; (b) sign in once in the PWA and hand a session to
the app via a link — a second credential-transfer channel nobody has threat-modelled
(security lane would have to review), and still no delete; (c) narrow M4 exit (2) to a
dev build — defeats the purpose of the TestFlight run.

R2 (F2, F3, F4, F10). Make the phone's step 1 a single, complete, copyable command:
`remotectl login --relay https://<host> rc-enroll:…`. `login --relay` writes the relay URL
into the config (creating the default config if absent); the phone fills in its own
origin. Add a Copy button (and Web Share on iOS) next to it. Drop `npx` everywhere.
Rejected: (a) embed the relay host inside the token — changes the token format and the
relay's parser (relay lane), and a longer token worsens F4; (b) a separate
`remotectl init` command — one more step for the stranger; `init` also sits next to the
reserved `init-hook`; (c) reverse device-code flow (computer shows a short code, phone
approves) — best UX, but a new relay route and auth surface; recorded as owner question
Q-UX-2 for after M1.

R3 (F5). The login success message lists the remaining steps in README order and ends
with `remotectl status --self-test`. Rejected: auto-running `hooks install` from `login`
— writes into the user's agent config without an explicit command (I4 spirit).

R4 (F6). Fix the vocabulary as: **computer** = what runs `remotectl`; **phone** = a
paired phone; **session** = one agent run. Native "Machines"/"Pair a machine" → "Computers"
/ "Pair a computer"; CLI prose "devices" → "phones" while the `devices` command name stays
(renaming is breaking; an alias is optional, not proposed). App tab "Agents" may stay as a
deliberate native label only if `screens.md` records it.

R5 (F7, F11). Release-build hygiene: no WP ids in UI, the Face ID row reflects the real
setting or is removed, errors mapped to sentences, `app.json` version set from the
release pipeline (V3-C11 owns the pipeline; the mapping is ours).

R6 (F8, F13). README facts (status note covers the native app as "simulator only, not on
TestFlight"; layout lists `apps/mobile`, `packages/phone-core`; drop or qualify "about ten
minutes" until M1-14b passes) — hand to the evidence lane alongside V3-P06, not a
competing edit. `screens.md`: one tap-guard value (the code's), a native section, no `npx`.

R7 (F9). Write a one-page privacy policy (what the relay stores: passkey public keys,
device ids, push tokens; what it never sees) and host it on the Q2 domain before any
external TestFlight. Rejected: terms of service now — no payment, no public listing yet.

R8 (F12). `pair` sends the name stored at enrolment (returned with the credentials) and
falls back to the hostname only when none was given.

## 6. Risks

| ID | Risk | Likelihood | Impact | Mitigation | Related |
|---|---|---|---|---|---|
| RV-UX-R1 | Owner reaches M4-08 with a paid Apple account and discovers the app cannot sign in | high | high | RV-UX-06/07 as an explicit M4-08 dep | R1, Q22 |
| RV-UX-R2 | Second-user run fails T2 on `npx` / missing relay URL, burning the single scarce tester | high | high | RV-UX-01..04 before M1-14b | R12, Q13 |
| RV-UX-R3 | Users pair but never receive requests because the CLI skipped hooks/daemon | medium | medium | RV-UX-04; self-test in the success path | R5 |
| RV-UX-R4 | Static "Face ID before Allow: On" read as a security guarantee | low | medium | RV-UX-08 | D7 |
| RV-UX-R5 | External TestFlight blocked on a missing privacy policy URL | certain when attempted | low | RV-UX-10 on the Q2 domain | Q2, V3-C11 |

## 7. Work items

Sizes: S = 1 h, M = 2 h, L = 4 h. Lane-owned paths are marked `[lane]` per
`docs/analysis/v3/PARALLEL.md`; README edits go through the evidence lane.

| ID | Title | Size | Deps | Files touched | Acceptance criteria | Finding |
|---|---|---|---|---|---|---|
| RV-UX-01 | Drop `npx` from every phone instruction | S | — | `apps/web/src/screens/pairing.tsx`, `packages/phone-core/src/realtime/phone.ts`, `docs/product/screens.md`, their tests | `grep -rn "npx remotectl" apps/web/src packages/phone-core/src apps/mobile/src docs/product` → 0 hits; `pnpm check` green | F2 |
| RV-UX-02 | `remotectl login --relay <url>` writes the relay URL (creates default config if missing) | M | — | `apps/agent/src/cli/login.ts` (new), `apps/agent/src/cli/main.ts` (≤3-line dispatch, hotspot), `apps/agent/src/cli/*.test.ts` | Test: empty config dir + `login --relay https://r.example <token>` (fake relay) → config file exists with `relay.url === "https://r.example"`; `http://` rejected unless host is loopback (exit ≠ 0, message names the flag); existing `relay.url` differing from `--relay` → exit ≠ 0 without overwrite; `HELP_TEXT` contains `--relay` | F3, F10 |
| RV-UX-03 | Phone shows the complete login command with its relay origin and a Copy/Share button | S | RV-UX-01, RV-UX-02 | `apps/web/src/screens/pairing.tsx`, `packages/phone-core` (if the command is built there), tests | Unit/Playwright: rendered command matches `^remotectl login --relay https://\S+ rc-enroll:[A-Za-z0-9_-]{43}$` (origin = app origin); a button with accessible name "Copy command" exists and writes that exact string to the clipboard (mocked) | F3, F4 |
| RV-UX-04 | Login success lists hooks, install, pair and self-test | S | RV-UX-02 | `apps/agent/src/cli/login.ts` or `main.ts` message, test | Test: success stdout contains `remotectl hooks install`, `remotectl install`, `remotectl pair`, `remotectl status --self-test` in that order; failure output contains no raw relay code (asserts mapped sentence for `invalid_token`/`expired`) | F5, F11 |
| RV-UX-05 | Quick start uses `login --relay`; status note covers native app; layout complete; "ten minutes" qualified | S | RV-UX-02 | `README.md` `[evidence]` | `grep -n "config.json" README.md` shows no hand-edit step for `relay`; README contains `apps/mobile` and `packages/phone-core`; status note contains "native" ; README `docs-drift`/link check green | F8, F10 |
| RV-UX-06 | Native passkey sign-in and registration (invite, recovery code) in release builds | L | Q2 (associated domains), Q-UX-1 | `apps/mobile/src/app/account/**` (new), `apps/mobile/src/core/authorize.ts`, `apps/mobile/app.json` (associated domains), tests | Jest: with `__DEV__=false` the Settings tab renders a "Sign in" row and no `DeveloperRelay`; sign-in/register use a passkey port with a fake in tests (success, cancelled, offline, invalid invite mapped to the PWA's sentences); `grep -n "associatedDomains" apps/mobile/app.json` → 1 hit | F1 |
| RV-UX-07 | Native enrol-a-computer, QR pair, revoke phone, delete account | M | RV-UX-06, RV-UX-03 | `apps/mobile/src/app/(tabs)/settings.tsx`, `apps/mobile/src/core/authorize.ts`, `apps/mobile/app.json` (`NSCameraUsageDescription`), tests | Jest: enrol screen shows the RV-UX-03 command; `deleteAccountWithoutPasskey` removed or never returns a constant; delete calls the relay after a passkey assertion (fake); `grep NSCameraUsageDescription apps/mobile/app.json` → 1 hit | F1 |
| RV-UX-08 | Native release hygiene: no sample data, no WP ids, real Face ID state, mapped errors | S | RV-UX-06 | `apps/mobile/src/state/store.ts`, `apps/mobile/src/ui/screen.tsx`, `apps/mobile/src/app/(tabs)/settings.tsx` | `grep -rnE "['\"]M[0-9]-[0-9]{2}" apps/mobile/src/app apps/mobile/src/ui` → 0; `grep -n "String(error)" apps/mobile/src/app` → 0; Jest: with `__DEV__=false` initial store state has no fixture sessions (`sample !== true`) | F1, F7 |
| RV-UX-09 | Vocabulary alignment: computer / phone / session across CLI, PWA, app, docs | S | — | `apps/mobile/src/app/(tabs)/settings.tsx`, `apps/mobile/src/ui/screen.tsx`, `apps/agent/src/cli/main.ts` (strings only), `docs/product/screens.md` | `grep -rniE "pair a machine|['\"]Machines['\"]|No paired devices" apps/mobile/src apps/agent/src/cli apps/web/src` → 0; app alert reads "The codes match"; `screens.md` has a glossary paragraph naming the three terms | F6 |
| RV-UX-10 | Privacy policy page on the production domain | S | Q2 | `apps/web/public/privacy.html` `[clients]` or `docs/legal/privacy.md` + relay static route | File exists; contains sections "What the relay stores" and "What it never sees"; linked from README and the native Settings tab (`grep -rn "privacy" apps/mobile/src/app` ≥ 1) | F9 |
| RV-UX-11 | `pair` uses the enrolment name; `screens.md` and help text drift fixed | S | — | `apps/agent/src/cli/main.ts` (pair args), agent credentials store, `docs/product/screens.md` | Test: credentials with `name: "Work laptop"` → `runPairing` receives `agentName: "Work laptop"`; without it, hostname; `grep -c "600 ms\|700 ms" docs/product/screens.md` shows one distinct value equal to the code constant; `HELP_TEXT` contains `--agent` | F12, F13 |

Not proposed here (already planned): README positioning V3-P06 / V2-P03; version gate
V3-C12; desktop PWA install V3-C15; release pipeline V3-C11; second-user run M1-14b;
TestFlight archive and APNs prod M4-08.

## 8. Open questions for the owner

- **Q-UX-1** Native sign-in before TestFlight: build RV-UX-06/07 as an M4-08 dependency, or
  accept an M4-08 that only proves the archive and a dev build? **Default:** make them a
  dependency; M4 exit (2) is unreachable otherwise.
- **Q-UX-2** Long term, keep "copy a command" enrolment or move to a device-code flow
  (computer shows a short code, phone approves)? **Default:** copy command for 0.1.0;
  revisit after the second-user run.
- **Q-UX-3** Canonical words: "computer" (not "machine") and "phone" (not "device") in
  all user-facing copy, the `devices` command name kept? **Default:** yes.
- **Q-UX-4** Native session list label: keep "Agents" (native) vs "Sessions" (PWA)?
  **Default:** keep "Agents" in the app, record it in `screens.md` as intentional.
- **Q-UX-5** Privacy policy hosting: static page on the relay domain or GitHub Pages?
  **Default:** relay domain (Q2), written before any external tester.

## 9. Sources

- `README.md` L7-11, L16, L25, L44, L57-60, L65-71, L76-97, L105, L112, L119-129, L153,
  L158-171
- `apps/agent/src/cli/main.ts` L80-111, L226-233, L462-465, L527-528, L609-654, L779-787,
  L796-866, L945, L957-976; `apps/agent/src/core/pairing.ts` L112-117, L208-212
- `apps/web/src/screens/pairing.tsx` L17-61, L72, L80-181, L235-281;
  `screens/auth.tsx` L13-34, L72-155, L208-234; `screens/onboarding.tsx` L7-96;
  `screens/main.tsx` L21-240, L281; `sw.ts` L36-176; `routes.tsx` L56-114
- `packages/phone-core/src/realtime/phone.ts` L184-198, L354, L480-492
- `apps/relay/src/core/pairing-service.ts` L23-24, L65-95, L251
- `apps/mobile/src/app/(tabs)/settings.tsx` L70-74, L104-122, L166-218, L253-259;
  `src/state/store.ts` L47-56, L116-130; `src/ui/screen.tsx` L33-38;
  `src/core/authorize.ts` L83-84; `src/core/fixtures.ts`; `app.json`
- `docs/product/screens.md` L15-16, L31, L92, L127, L293, L325-334;
  `docs/product/usability-protocol.md` L11-14, L32, L44-48;
  `docs/verification/second-user.md`
- `docs/analysis/ROADMAP.md` §4 M4-05…M4-08 (L1122-1150), L533, §7 risks R1-R19
  (L1224-1242), status rows M0-27a/b, M1-09b, M1-10, M1-14b;
  `docs/adr/0002-*`, `docs/adr/0017-native-phone-app.md` L60-96
- `docs/analysis/v3/ROADMAP-v3.md` L20-21, L45, L49, L67; `docs/analysis/v3/PARALLEL.md`
  L29-38; `docs/analysis/review/00-state.md` §4; `docs/analysis/review/01-roles.md` L28
