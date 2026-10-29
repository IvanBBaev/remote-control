# 03 — Agent-integration review (AGT), as built at main @ f0281ef

Role 03, Agent-integration engineer. Scope: `apps/agent` minus CLI ergonomics (role 09)
and module structure (role 08).

## 1. Summary

The core of the agent is solid. `hook.js` fails open. The receiver is loopback-only and
token-gated with no decide route. The adapters map phone decisions only, the argv gate
holds, and no code path grants on its own (I4 in the 00-state numbering). The weak spot
is the **hold policy in practice**. Every blocking hook is held for the full ~29m50s
whenever no phone can answer: no relay, not logged in, no paired phone, agent revoked.
It is also held when the request cannot be shown on a phone. And the pending store hands
off a session's earlier request as soon as a second one arrives, which loses concurrent
subagent prompts. Everything vendor-facing is still unverified on real CLIs (M0-23b,
Codex, Gemini, SDK all "pending the owner").

**Verdicts:**
- **M1:** ready-with-fixes. F1 and F2 must land first, and M0-23b must run.
- **Native-app TestFlight:** ready-with-fixes. The agent does not block the build, but
  testers will hit F1 and F2 on day one.

## 2. Verified facts

1. **Blocking requests are always registered.** The dispatcher registers every blocking
   hook in the store unless `paused`. Nothing checks whether any phone could answer.
   (`apps/agent/src/core/hook-dispatcher.ts:95-126`)
2. **The relay link is optional at runtime.** It is created only when
   `config.relay !== undefined && credentials !== undefined`; otherwise the agent logs
   `relay_disabled` and keeps serving hooks. (`apps/agent/src/cli/main.ts:331`, `:386`,
   `:470`) The test `main.test.ts:613` asserts that `run` starts with `relay_disabled`
   and the hook endpoint published.
3. **A revoked agent stops for good but keeps holding.** On close 4002 or `isRevoked`,
   the relay client stops and never reconnects. The hook receiver keeps holding.
   (`apps/agent/src/core/relay-client.ts:70-71`, `:112-120`)
4. **Hold arithmetic.** The store deadline is `hookTimeoutMs - 10_000`
   (`pending-store.ts:7-8`, `:175`). `hook.js` gives up at `T - min(5 s, T/2)`
   (`apps/agent/src/hook/run-hook.ts`, `HOOK_MARGIN_MS=5000`). The default
   `holdSeconds` is 1800.
5. **One pending request per session and kind.**
   - The slot key is `kind\0sessionId` (`pending-store.ts:123`).
   - A new registration hands off the previous entry with reason `replaced`
     (`pending-store.ts:166-206`, see `:200-204`).
   - Tests pin this: "one in flight per slot" (`pending-store.test.ts:124`, `:132-144`).
6. **Unshowable requests are still held and still ring the doorbell.** `added()` builds
   the phone message only if `requestMessage()` returns a view. When it does not, the
   request stays held, and every paired peer without a live session still gets a doorbell
   (`apps/agent/src/core/session-hub.ts:852-870`). The views return `undefined` on any
   schema miss (`approval-view.ts:115-132`; `question-view.ts:34-40`, including
   duplicate question texts).
7. **Gemini matcher and decisions.** The gate matcher is
   `^(run_shell_command|write_file|replace)$` (`hooks-installer.ts:50-53`). Gemini
   capabilities have `allow: false` (`adapters/gemini/adapter.ts:13-20`). `decideGemini`
   returns `{}` for everything except deny (`:80-83`).
8. **Bound check covers start only.**
   - `start` checks `permissionModeWithin(mode ?? 'default', maxPermissionMode)`
     (`apps/agent/src/core/launcher.ts:194`).
   - `instruct` goes through `followUpTarget`, which never consults `maxPermissionMode`
     (`launcher.ts:142-156`, `:217-243`).
   - The resume argv has no mode: `['--resume', id, '--bg', prompt]`
     (`adapters/claude-code/spawn.ts`, `resumeSessionArgv`).
   - A default start passes no `--permission-mode` (`startSessionArgv`; ADR 0006 "The
     argv").
9. **Service environment is HOME and PATH only.** The launchd and systemd units set only
   `HOME` and `PATH` (`cli/service-launchd.ts:48-49`, `cli/service-systemd.ts:79-80`).
   The daemon resolves Claude's config dir from `CLAUDE_CONFIG_DIR || ~/.claude` and
   Codex from `CODEX_HOME` (`container.ts`). The transcript reader only accepts files
   under `realpath($claudeConfigDir/projects)` (`adapters/claude-code/transcript.ts:181-190`).
10. **Absolute node path everywhere.**
    - The hook command embeds `process.execPath`:
      `"${execPath}" "${scriptPath}" ${timeout}` (`hooks-installer.ts:130-137`, `:380`).
    - So do the service units (`service-launchd.ts:48`, `service-systemd.ts:79`,
      `service-windows.ts:56`).
    - `installLocationProblem` refuses only npx, dlx, tmp and non-built scripts
      (`core/install-location-problem.ts:8-18`).
    - This machine itself has four nvm versions (`ls ~/.nvm/versions/node`: v20.20.2,
      v22.23.0, v22.23.2, v24.22.1).
11. **No client-side liveness check on the relay socket.**
    - `node-websocket.ts` (37 lines) has no ping or silence timer.
    - `relay-client.ts` ignores `pong` (`:198`) and never sends `ping`.
    - The relay pings and terminates after 35 s of silence (`apps/relay/src/core/relay-router.ts:544-563`).
    - The phone sends an app-level `ping` (`packages/phone-core/src/realtime/relay-socket.ts:105`).
12. **Spawn has no shell and no timeout.**
    - It uses `shell: false`, `stdio: 'ignore'`, and command `'claude'` resolved from PATH
      (`spawn.ts` `spawnBackgroundSession`; `container.ts:272`).
    - Nothing bounds the wait for `exit` (`launcher.ts:203-216`).
    - The hub tracks the launch promise (`session-hub.ts:829-848`).
13. **I4 (never grants) holds in code.**
    - The store never produces a decision (`pending-store.ts:32-36`).
    - `decideClaudeCode` returns allow or always only for a phone `allow` or `always`
      (`adapters/claude-code/decide.ts:28-50`).
    - The Codex adapter only allows on a phone allow (`adapters/codex/adapter.ts:79-93`).
    - In SDK mode, no decision means deny (`adapters/claude-sdk/sdk-sessions.ts:128-147`).
    - `onExpire: "deny"` produces only a deny (`main.ts:376-384`).
14. **The argv gate passes:** `node apps/agent/scripts/check-argv-policy.mjs` exits 0.
15. **Invariant numbering drifts.**
    - ROADMAP §1 defines I4 as "installable from one npx command and keeps itself running"
      (`docs/analysis/ROADMAP.md:165-166`).
    - `00-state.md:27`, the project `CLAUDE.md` and `session-hub.ts:216` use I4 for
      "never grants".
    - `pending-store.ts:35` cites "§1, D10" for it.
16. **Nothing is verified on a real vendor CLI.**
    - `docs/verification/claude-code-hooks.md`: only the synthetic overhead is measured.
      A2, A3, deny, ctrl-c and `--bg` are pending (ROADMAP M0-23b `blocked-owner`,
      `ROADMAP.md:56`).
    - `codex.md`, `gemini.md` and `claude-sdk.md` are all "pending the owner", with empty
      result tables.
17. **Scoped test run:** `./node_modules/.bin/vitest run apps/agent` (Node v26.12.1,
    run while other reviewers were loading the machine) reported
    `Test Files 2 failed | 69 passed | 3 skipped (74)`,
    `Tests 3 failed | 924 passed | 11 skipped (938)` in 547 s.
    - **Second run, filtered for failures:** only
      `FAIL apps/agent/src/package.test.ts — Error: spawn pnpm ENOENT`. This is
      environmental: `pnpm` is not on PATH in this shell.
    - **The other first-run failure:** it did not reproduce, so it is likely a
      timing-sensitive test under load. That is unconfirmed and should be handed to role
      QA as a flake candidate.
    - I could not run the gate itself (`pnpm check`), for the same PATH reason.

## 3. Assumptions

- **A-1. Subagents share the session id.** Claude Code subagents (Task tool) running in
  parallel emit `PermissionRequest` with the **parent** `session_id`, so two can be
  pending at once. This is plausible from the docs but unverified, and is the subject of
  V2-AG-01. Parallel tool calls in one turn may also overlap.
- **A-2. A held hook blanks the terminal prompt** for the whole hold (04 A3; unverified,
  M0-23b).
- **A-3. `claude --resume <id> --bg` does not restore the original `--permission-mode`.**
  It starts in `default` or in the repo's `permissions.defaultMode`. When
  `--permission-mode` is absent, the merged settings' `defaultMode` (including a repo's
  committed `.claude/settings.json`) applies.
- **A-4. Gemini fires `BeforeTool` before its own approval policy.** This includes calls
  Gemini would auto-approve: YOLO mode, allow-listed tools, trusted folders (04 §2.12
  "fires for every tool call"; unverified).
- **A-5. Windows spawn.** libuv's PATH search on Windows tries only `''`, `.com` and
  `.exe`, and Node refuses `.cmd`/`.bat` without a shell (CVE-2024-27980 hardening). An
  npm-installed `claude.cmd` therefore cannot be spawned, while the native installer's
  `claude.exe` can. Not tested here (no Windows).
- **A-6. Codex and Gemini hooks may need an extra enable flag** in their own config, on
  top of the files the installer writes (verification checklists only).

## 4. Findings

### F1 — high — Every blocking hook is held ~30 min when no phone can answer

**Evidence:** facts 1–3. Nothing short-circuits on:
- no relay link (`config.relay` absent or no credentials, `main.ts:386`);
- zero paired, non-revoked peers;
- a link stopped for good (4002 revoked, `relay-client.ts:112-120`).

**Why it matters:**
- The normal first-run order in the README flow is `hooks install`, then `run`, then
  `pair`. In between, every Claude Code permission prompt disappears for 29m50s; per
  A-2 the terminal shows nothing.
- The same happens after a revoke, after `logout`, or with a typo in `relay.url`.
- The user is at the desk and Claude looks hung. That is exactly the "agent-caused hang"
  the success criterion forbids (ROADMAP §1 success criteria).
- `remotectl pause` (M1-03) is the only escape, and the user has no reason to know it.

**Touches:** I2 ("cannot get decided → released"), D10, R11.

### F2 — high — A second request in the same session silently hands off the first

**Evidence:** fact 5. `register` replaces the `kind+sessionId` slot and finishes the
previous entry with `handoff/replaced`. The phone receives `withdrawn` for it, and only
the newest request stays decidable.

**Why it matters:**
- With parallel subagents (A-1), request 1 goes to Claude Code's terminal prompt while
  the phone shows request 2.
- In a `--bg` session started from the phone (M1-04), nobody ever sees that terminal
  prompt, so that subagent stalls indefinitely.
- 04 risk 11 asked only for a 2 s dedupe of identical requests
  (`04-agent-integration.md:518`). The slot replacement goes further than D11 and is
  codified by tests.
- This is the most common shape of real Claude Code work: subagent fan-out.

**Touches:** I2, D11 (dedupe), D25 (first-decision-wins assumes one request per
prompt), R11, R17; overlaps the V2-AG-01 fixtures (cite, do not duplicate).

### F3 — medium — Requests the phone cannot render are held for the full deadline and still ring the doorbell

**Evidence:** fact 6. Any drift in the `AskUserQuestion` input makes `questionView`
return `undefined`, and so does a payload that fails `ApprovalRequest` (`approval-view.ts:115-132`).
Drift includes a new field shape, more than `MAX_OPTIONS`, or duplicate question texts
(`question-view.ts:34-40`).

The request is then still held for ~30 min (`hook-dispatcher.ts:103-118`). A doorbell
push wakes the phone (`session-hub.ts:866-870`), but the phone finds nothing to decide.

**Why it matters:** this is a silent 30-minute hang that is triggered by a vendor schema
change (R3, R15-like drift), with nothing in the log beyond the registration.

**Touches:** I2, D10, R11.

### F4 — medium — Gemini: every shell or write call blocks for up to 30 min, and the phone can only deny

**Evidence:** fact 7 and A-4. `BeforeTool` holds `run_shell_command|write_file|replace`
for `holdSeconds`. The phone has no Allow. A phone "allow" or "Reply in terminal" just
hands off. With no phone action, Gemini's own confirmation (or its auto-approval)
happens only at the deadline.

**Why it matters:**
- For a user at the desk, Gemini becomes unusable while `remotectl run` is up: each
  edit waits 30 min.
- Combined with F1, this happens with no phone paired at all.
- The `Claude PermissionRequest` gate fires only when a prompt would show. The Gemini
  gate fires on every matching call.

**Touches:** D12, D10, ADR 0013; `docs/verification/gemini.md` is still pending.

### F5 — medium — The ADR 0006 bound is not enforced on follow-ups or against repo settings

**Evidence:** fact 8 and A-3.
- `instruct` resumes without `--permission-mode` and without a bound check. A session
  started in `plan` in a `plan`-bound folder therefore continues in `default` (or the
  repo's `defaultMode`) after the first follow-up.
- A default start passes no flag, so a cloned repo's committed
  `.claude/settings.json` `"defaultMode": "acceptEdits"` lifts a `default`-bound start
  to `acceptEdits`.

**Why it matters:** ADR 0006 says "the bound is the agent's, never the phone's", and
`launcher.ts:192-193` says it is "checked before any spawn". It is checked before one
spawn out of two, and it does not actually pin the mode.

**Touches:** ADR 0006, D13, I1 (repo content changes what the phone's decision means).

### F6 — medium — Service units drop `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and the SDK key

**Evidence:** fact 9. A user with `CLAUDE_CONFIG_DIR` set runs `remotectl hooks install`
from a shell, which writes into `$CLAUDE_CONFIG_DIR/settings.json`. The launchd or
systemd daemon then:
- reads `~/.claude` instead (registry, `agents --json`);
- spawns `claude --bg` with a different config dir, which has no hooks there, so
  phone-started sessions get no remote prompts and possibly a different login;
- rejects every transcript path for backfill (`transcript.ts:187-190`).

The same applies to `CODEX_HOME`. `sessions: "sdk"` under a service has no
`ANTHROPIC_API_KEY`; `status` prints "not set" (`main.ts:539`), but `install` does not
warn. Windows Task Scheduler inherits the user environment and is not affected
(`service-windows.ts:41-42`).

**Touches:** D11 ("respecting `CLAUDE_CONFIG_DIR`"), D22, R5, R12.

### F7 — medium — The absolute Node path goes stale under version managers

**Evidence:** fact 10. After `nvm uninstall` or an fnm/asdf/mise cleanup of the old
version:
- every hook command fails. Claude Code logs a non-blocking hook error, the terminal
  prompt appears, and remote approval silently stops;
- the launchd job crash-loops every 10 s under `KeepAlive`/`ThrottleInterval 10`.

`installLocationProblem` checks only the script path, never `execPath`. Hooks report
`outdated` only when `status` happens to run from a different Node.

**Touches:** I4 (ROADMAP numbering: "keeps itself running"), D22, R12.

### F8 — medium — The agent cannot detect a dead relay socket

**Evidence:** fact 11. After sleep/wake, a Wi-Fi change or a NAT timeout, the relay drops
the socket after 35 s. The agent's undici socket can stay "open" until a TCP write fails,
which can take minutes on macOS. During that window the phone shows the machine offline,
decisions cannot arrive, and held hooks run into F1-style hangs. The phone already pings
the relay at the app level; the agent does not.

**Touches:** D15 (heartbeat defined only server-side), D4 reconnect, R14.

### F9 — medium — Windows: `start` and `instruct` fail for npm-installed Claude Code

**Evidence:** fact 12 and A-5. `spawn('claude', …, {shell:false})` cannot run
`claude.cmd`. `claude --version` fails too, so follow-ups are disabled and every phone
start returns `start_failed`, with no hint in `status`.

**Touches:** D13, D22, Q14 (all three OS installers).

### F10 — low — `claude --bg` has no spawn timeout

**Evidence:** fact 12. If `--bg` blocks (a trust dialog, a login prompt, research-preview
change R3), the phone never gets a reply, and the tracked promise keeps the hub's
`work` set non-empty during shutdown drains.

**Touches:** R3, D13.

### F11 — low — Invariant numbering drift

**Evidence:** fact 15. Code and review docs cite "I4 = never grants"; the binding
ROADMAP says I4 is npx/keep-running. Reviewers and executors will mis-cite ADR
deviations.

**Touches:** ROADMAP §1, project `CLAUDE.md`.

### F12 — low — Settings backups accumulate forever

**Evidence:** `hooks-installer.ts` writes `settings.json.backup-<ts>` on every changing
install, upgrade or uninstall, and nothing prunes them. These files are in the user's
`~/.claude`, `~/.codex` and `~/.gemini`.

**Touches:** D11 installer contract (M0-14).

## 5. Recommendations

1. **F1: answerability gate in the dispatcher.**
   - Add `canAnswer(): boolean` to `HookDispatcherOptions`. It is false when the relay
     link is absent or stopped, or when the non-revoked peer count is 0.
   - When it is false, return `HANDOFF` at once and log `hook_handoff_no_answerer`. A
     merely reconnecting link still holds, because the phone may answer after reconnect.
   - Make `status` say "hooks hand off: no paired phone".
   - **Rejected:** lowering `holdSeconds` (it hurts the away case); auto-pause (hidden
     state the user did not choose).
2. **F2: allow N concurrent requests per session.**
   - Key the slot by `kind+sessionId+fingerprint`. Keep the 2 s duplicate window on equal
     fingerprints, and cap at 8 per session, where the 9th hands off.
   - The phone protocol already carries per-request ids.
   - **Rejected:** keeping replacement but showing a "replaced" toast (it still strands
     the earlier subagent).
3. **F3: refuse unshowable requests up front.**
   - Check showability at registration via an `isShowable(request)` hook supplied by the
     hub (the same `approvalView`/`questionView`). If it fails, hand off immediately,
     send no doorbell, and log `request_unshowable` with only tool name and reason code.
   - **Rejected:** a generic "unknown request" card (the phone would decide on content it
     cannot show, which goes against D7 binding).
4. **F4: shorter Gemini hold.**
   - Add a separate `hooks.gemini.holdSeconds`, defaulting to 120, written by the Gemini
     installer.
   - Document that Gemini is "deny-window" only.
   - **Rejected:** dropping `write_file`/`replace` from the gate (loses the one
     protection Gemini users get).
5. **F5: pin the permission mode.**
   - In a **plan-bound** folder (bound < `default`), refuse `instruct` with
     `follow_up_unsupported`. This is the cheap fix, inside `claude-surface` lane files.
   - Amend ADR 0006 so that both builders always pass an explicit `--permission-mode`
     (`default` included). This needs an ADR change to the one-literal gate.
   - **Rejected:** reading the repo's `.claude/settings.json` to detect `defaultMode`
     (parsing someone else's settings; it misses user and local layers).
6. **F6: capture the agent-relevant config-dir variables.**
   - At `install`, write `CLAUDE_CONFIG_DIR` and `CODEX_HOME` into the unit's
     `environment` when they are set.
   - Warn when `agent.sessions === 'sdk'` and the service has no key.
   - **Rejected:** capturing `ANTHROPIC_API_KEY` into the plist or unit (a secret in a
     world-readable-by-default file).
7. **F7: detect version-manager Node paths.**
   - `installLocationProblem` should also inspect `execPath` for `/.nvm/versions/`,
     `/fnm/node-versions/`, `/.asdf/installs/` and `/mise/installs/`, and warn with a
     suggested stable Node.
   - `status` should check that the recorded hook `execPath` still exists.
   - **Rejected:** bare `node` in the hook command (it resolves through Claude Code's
     PATH, which is unpredictable under GUI launches).
8. **F8: agent-side liveness.** Mirror the phone: send an app-level `ping` every 25 s.
   If no frame arrives for 35 s, close with 4xxx and go through the normal backoff.
9. **F9: Windows binary resolution.** On win32, resolve `claude.exe` explicitly. If only
   `claude.cmd` exists, `status` and `start` report `claude_not_spawnable` with the
   native-installer hint.
   - **Rejected:** `shell: true` (it breaks D13).
10. **F10:** add a 60 s timeout around `--bg` spawn, then kill, `start_failed`, and log
    `launch_timeout`.
11. **F11:** pick one numbering. Default: ROADMAP §1 is authoritative. Rename the
    never-grants property as "I1 corollary (D10)" in code comments, `00-state.md` and
    `CLAUDE.md`.
12. **F12:** keep the 3 newest backups per file.

## 6. Risks (new)

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R20 | Subagent fan-out loses prompts: the earlier request is handed off to an unseen terminal (extends R11, R17) | high once subagents are used | high | RV-AGT-02, V2-AG-01 fixtures |
| R21 | Agent running with nobody able to answer, so 30-min hangs at the desk (extends R11) | high on first use | high | RV-AGT-01 |
| R22 | Node version-manager cleanup silently disables hooks and the service (extends R12) | medium | medium | RV-AGT-07 |
| R23 | Repo-committed `defaultMode` or a resumed session exceeds the folder bound (extends R3) | low | medium | RV-AGT-05 |
| R24 | Half-open relay socket after sleep/wake: the machine looks offline for minutes (extends R14) | medium | medium | RV-AGT-08 |

## 7. Work items

| ID | Title | Size | Deps | Files touched | Acceptance criteria | Finding |
|---|---|---|---|---|---|---|
| RV-AGT-01 | Hand off at once when no phone can answer | M | — | `apps/agent/src/core/hook-dispatcher.ts`, `apps/agent/src/cli/main.ts` (dispatch wiring only, ≤3 lines per PARALLEL rule), `core/session-hub.ts`, tests | A test in `hook-dispatcher.test.ts` "hands off immediately when no phone can answer" passes. A `main.test.ts` case asserts that with no relay config a `PermissionRequest` returns `{}` in < 1 s and the log contains `hook_handoff_no_answerer` | F1 |
| RV-AGT-02 | Several pending requests per session | M | — | `core/pending-store.ts`, `pending-store.test.ts`, `core/session-hub.ts` | `pending-store.test.ts` "two different requests in one session both stay pending" passes. `grep -n "one in flight per slot" apps/agent/src/core/pending-store.test.ts` returns 0 hits. The 2 s duplicate test is still green | F2 |
| RV-AGT-03 | Unshowable request: immediate handoff, no doorbell | S | — | `core/hook-dispatcher.ts`, `core/session-hub.ts`, tests | Test "an AskUserQuestion with duplicate question texts is handed off at once and sends no doorbell" passes. The log has `request_unshowable` with no payload fields | F3 |
| RV-AGT-04 | Separate short Gemini hold | S | owner Q-AGT-2 | `core/agent-config.ts`, `core/hooks-installer.ts` (lane `claude-surface`), `core/parse-config.ts` (reserved key rule), tests | Test: `geminiHookSpecs` default writes `timeout: 120000`. `hooks-installer.test.ts` asserts Claude Code still gets 1800 | F4 |
| RV-AGT-05 | Bound for follow-ups in plan-bound folders (+ ADR 0006 amendment for explicit mode) | M | ADR amendment; owner Q-AGT-3 | `core/launcher.ts`, `adapters/claude-code/spawn.ts` (lane `claude-surface`), `argv-policy.test.ts` (lane `claude-surface`, A09), `docs/adr/0006-*.md` | `launcher.test.ts` "instruct refused in a plan-bound folder" passes. After the amendment: `startSessionArgv` output contains `--permission-mode default`. `node apps/agent/scripts/check-argv-policy.mjs` exits 0 | F5 |
| RV-AGT-06 | Service carries config-dir env; SDK key warning | S | — | `cli/service-launchd.ts`, `cli/service-systemd.ts`, `cli/service-shared.ts`, tests | `service.test.ts`: with `CLAUDE_CONFIG_DIR=/x`, the plist and unit contain `CLAUDE_CONFIG_DIR` `/x`. `grep -rn "ANTHROPIC_API_KEY" apps/agent/src/core/launchd-plist.ts apps/agent/src/cli/service-*.ts` returns 0 hits in written output | F6 |
| RV-AGT-07 | Detect version-manager Node and a missing hook `execPath` | S | — | `core/install-location-problem.ts`, `core/hooks-installer.ts` (lane `claude-surface`), tests | `install-location-problem.test.ts` "warns for an nvm execPath" passes. `hooks-installer.test.ts` "status reports node_missing when the hook execPath does not exist" passes | F7 |
| RV-AGT-08 | Agent-side relay heartbeat | S | — | `core/relay-client.ts`, `relay-client.test.ts` | Test "reconnects after 35 s without any inbound frame" passes with the fake timer. Test "sends ping every 25 s" passes | F8 |
| RV-AGT-09 | Windows: resolve `claude.exe`, report `claude_not_spawnable` | S | M0-25 (real Windows run) | `container.ts`, `adapters/claude-code/claude-cli.ts` (lane `claude-surface`), tests | Test with `platform: 'win32'` and only `claude.cmd` on PATH: `status` prints `claude_not_spawnable` and `start` returns `start_failed` without spawning | F9 |
| RV-AGT-10 | Spawn timeout for `--bg` and resume | S | — | `adapters/claude-code/spawn.ts` (lane `claude-surface`), `core/launcher.ts`, tests | `spawn.test.ts` "kills a start that has not exited after 60 s" passes. The log has `launch_timeout` | F10 |
| RV-AGT-11 | Invariant numbering aligned | S | owner Q-AGT-1 | `docs/analysis/review/00-state.md`, `apps/agent/src/core/{session-hub,pending-store}.ts` comments (project `CLAUDE.md` is local-only) | `grep -rn "(I4)" apps/agent/src` returns 0 hits. `grep -n "I4 — the agent never grants" docs/analysis/review/00-state.md` returns 0 hits | F11 |
| RV-AGT-12 | Prune settings backups to 3 | S | — | `core/hooks-installer.ts` (lane `claude-surface`), tests | `hooks-installer.test.ts` "keeps only the three newest backups" passes | F12 |

**Cited, not re-proposed:**
- M0-23b (real-CLI A2/A3/deny/ctrl-c/`--bg`), M1-04b, M1-05b, M1-07b;
- V2-AG-01 (subagent payload fixtures; needed to confirm A-1);
- V3-A06 (Elicitation), V3-A11/A12 (Copilot);
- the Codex, Gemini and SDK verification checklists in `docs/verification/`.

## 8. Open questions for the owner

- **Q-AGT-1:** Which invariant numbering is authoritative, ROADMAP §1 or 00-state? Default:
  ROADMAP §1, and the never-grants property becomes a named corollary.
- **Q-AGT-2:** Gemini hold length. Default: 120 s.
- **Q-AGT-3:** Do you accept amending ADR 0006 so `--permission-mode` is always explicit
  (`default` included) and resumes carry the session's start mode? Default: yes. Until
  then, refuse follow-ups in plan-bound folders.
- **Q-AGT-4:** With a link that is reconnecting (not stopped), keep holding for the full
  hold or cap the hold, for example at 5 min? Default: full hold, since F1 covers only
  "nobody can ever answer".
- **Q-AGT-5:** Can you run M0-23b with a parallel-subagent prompt included, so that A-1 is
  settled before RV-AGT-02 is sized finally? Default: yes, add it to
  `tools/verify-claude-code.ts` as an extra row.

## 9. Sources

- **Brief and review docs:** brief.md; `docs/analysis/review/00-state.md`,
  `docs/analysis/review/01-roles.md`.
- **ROADMAP and earlier analyses:**
  - `docs/analysis/ROADMAP.md` §1 (`:153-166`), D10 (`:303-330`), D11 (`:332-`),
    D15 (`:430-439`), M1-03 (`:893-900`), §7 R1–R19 (`:1224-1242`);
  - `docs/analysis/reports/04-agent-integration.md` (§2.12, risk 11 at `:518`);
  - `docs/analysis/v2/ROADMAP-v2.md` (V2-AG-01..10);
  - `docs/analysis/v3/ROADMAP-v3.md`, `docs/analysis/v3/PARALLEL.md` (lanes
    `claude-surface`, `rules`, `requester`, `sec-cards`, `evidence`).
- **ADRs:** `docs/adr/0006-bounded-permission-mode.md`, `docs/adr/0014-own-transcript-parser.md`.
- **Verification docs:** `docs/verification/claude-code-hooks.md`, `codex.md`,
  `gemini.md`, `claude-sdk.md`.
- **Agent code:**
  - `apps/agent/src/hook/{hook,run-hook}.ts`;
  - `adapters/hook-receiver.ts`;
  - `core/{hook-dispatcher,pending-store,session-hub,launcher,hooks-installer,approval-view,question-view,relay-client,relay-link,install-location-problem,launchd-plist}.ts`;
  - `adapters/claude-code/{decide,spawn,claude-cli,transcript}.ts`;
  - `adapters/{codex,gemini}/adapter.ts`;
  - `adapters/claude-sdk/sdk-sessions.ts`;
  - `adapters/node-websocket.ts`;
  - `cli/{main,service-launchd,service-systemd,service-windows}.ts`;
  - `container.ts`.
- **Other code:** `apps/relay/src/core/relay-router.ts`,
  `packages/phone-core/src/realtime/relay-socket.ts`.
- **Commands:**
  - `node apps/agent/scripts/check-argv-policy.mjs` (exit 0);
  - `ls ~/.nvm/versions/node`;
  - `vitest run apps/agent` (started read-only; see fact 17).
