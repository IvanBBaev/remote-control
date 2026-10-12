# 01 — Product & UX strategy

Role #1 report for `00-brief.md`. Status: 2026-10-12. Scope: positioning against
Claude Code's built-in Remote Control, what to take from Coucou, MVP journeys,
what is out, PWA information architecture, success criteria.

## 1. Summary

1. For a single Claude Code user on a claude.ai Pro/Max plan, **Claude Code's own Remote Control already covers MVP items 1, 2 and most of 3** (approvals, questions, push, cross-machine session list, diffs, follow-ups, and — via the Desktop folder list plus Projects "Work locally", beta — starting a session in a chosen folder from the phone). Say so in the README.
2. The honest remaining reasons to build: (a) one inbox for **several agents** (Codex, Gemini CLI, …); (b) users on **API keys, Bedrock/Vertex/Foundry, gateways or ZDR** who cannot use Remote Control or Channels at all; (c) **privacy**: no transcript on a third-party server, E2E payloads, metadata-only relay; (d) **"Always"** (rule creation) from the phone, which Remote Control does not document; (e) start a session in **any allow-listed repository** without the Desktop app or a per-folder server; (f) per-project **history and cost**.
3. Re-order the MVP: **M0** = pair + Allow/Deny + push (walking skeleton, Claude Code only). **M1** = AskUserQuestion, Always, follow-up instruction, new session in a repo, a *thin* session view (status, steps, last turn, file names and `+N −M`, no diff bodies). **M2** = second agent adapter, diff bodies, history/cost, presence. Item 4 stays in M2 but the adapter boundary is in the protocol from day one.
4. Product invariant: **the agent never blocks the coding agent**. Hook not connected, phone silent, relay down → the terminal prompt takes over within seconds; a decision that cannot be delivered is dropped, never queued.
5. Adopt from Coucou: the Allow/Deny/Always card with biometrics on Allow only, decision bound to the exact request, decide-once + visible expiry, question view with exact labels and "Reply in terminal", plain-word tool labels, commands hidden until a deliberate tap, "connection lost N min ago — why" and the "Can't connect?" checklist. Drop: character, island, services, chat through the computer's keys, widgets/Siri, LAN pairing, user-deployed relay.
6. Success: within two weeks of M1 the owner approves ≥20 real requests from outside the home network with zero agent-caused hangs; a second user pairs from the README in ≤10 minutes without help.
7. Kill criterion: if Anthropic ships "Always" from the phone plus non-Claude agents before M1 is done, stop and use Remote Control.

## 2. Verified facts

### 2.1 Claude Code Remote Control (https://code.claude.com/docs/en/remote-control)

- F1. Connects claude.ai/code or the Claude iOS/Android app to a session running on your machine; the session list at claude.ai/code and the app's **Code** tab show local sessions with a computer icon and a green dot.
- F2. Three CLI modes: `claude remote-control` (server mode: on-demand sessions, `--spawn same-dir|worktree|session`, `--capacity` default 32, `--name`, `--continue`, `--session-id`, `--permission-mode`, `--[no-]create-session-in-dir`, spacebar shows a QR code), `claude --remote-control` / `--rc` (interactive session), `/remote-control` / `/rc` inside a session; also from the Desktop app and VS Code.
- F3. Requires a claude.ai login on Pro, Max, Team or Enterprise. Not supported: API keys, Bedrock, Vertex, Foundry, LLM gateways, ZDR and HIPAA orgs. `claude remote-control` exits with an error without an eligible login.
- F4. The local process must keep running (tmux/screen over SSH is the documented workaround); server mode exits after ~10 minutes without network; an interactive session disconnects after ~30 minutes of failed presence heartbeats; one remote session per interactive process; sessions can be resumed for ~4 hours after the server stops (`--continue`, `--session-id`, v2.1.200+).
- F5. Outbound HTTPS only (polls the Anthropic API); the transcript is stored on Anthropic servers while connected.
- F6. From the device: send messages, see a diff pane for git repos, control model and effort (v2.1.238+), see and stop subagents.
- F7. Mobile push: `/config` → **Push when Claude decides** (proactive) and **Push when actions required** (permission prompts and questions). No per-project or per-event configuration is documented. Pushes are skipped while you type in or focus the connected terminal; `CLAUDE_CLIENT_PRESENCE_FILE` extends this to "at the machine".
- F8. "Claude Code keeps permission prompts and `AskUserQuestion` questions open until you answer them"; other dialogs expire after the 5-minute `dialogExpiry`.
- F9. Trusted Devices (beta): device enrollment, sign-in no older than 18 hours, biometric step-up (Face ID, Touch ID, Windows Hello, passkey) refreshes the session.
- F10. Settings: `remoteControlAtStartup`, `disableRemoteControl`.
- F11. Not documented anywhere on the page: creating an "always allow" rule from the phone; per-session cost or token history; any agent other than Claude Code.

### 2.2 Projects and Desktop

- F12. Projects (https://code.claude.com/docs/en/claude-projects, public beta, Pro/Max): "Run a thread on your own computer" — enable in the Desktop app under **Settings > Claude Code > "Use this computer from your phone and claude.ai"** with a **folder list**, or run `claude remote-control` in the folder (`--spawn worktree` supported). Needs Claude Code v2.1.280+.
- F13. From a project conversation: **+ → Work locally** → card "Allow Claude to work in a folder on your device" → pick the folder → optional Worktree → **Allow once**. The thread runs in **auto mode**; otherwise permission prompts wait inside the thread. Setting "Keep this computer awake for Remote Control"; message "Lost contact with your folder" when the computer sleeps or the app quits.
- F14. "A project can't run a thread on your computer while Require trusted devices is on." "You can't add a session you started yourself on your machine to a project."
- F15. Desktop (https://code.claude.com/docs/en/desktop): Dispatch (phone → Desktop) "requires a Pro or Max plan and is not available on Team or Enterprise"; "You get a push notification on your phone when it finishes or needs your approval"; sessions carry a **Dispatch** badge; "Control which sessions appear on your other devices" (per-session connect, `disableRemoteControl`, archive to hide).
- F16. Cloud sessions (https://code.claude.com/docs/en/claude-code-on-the-web): session sidebar with `+42 −18` diff indicator, archive/delete/share, `claude -p "…" --cloud <session-id>`; Pro/Max/Team (+Enterprise premium seats); no per-session cost shown, only "counts toward your plan's usage limits".

### 2.3 Channels (https://code.claude.com/docs/en/channels)

- F17. Research preview; Telegram, Discord and iMessage plugins need Bun and `--channels plugin:…`. "Channel servers that declare the permission relay capability can forward these prompts to you so you can approve or deny remotely." "Anyone who can reply through the channel can approve or deny tool use in your session." Requires a claude.ai login or Console API key; not Bedrock/Vertex/Foundry; Team/Enterprise need `channelsEnabled`.

### 2.4 Hooks (https://code.claude.com/docs/en/hooks) — the facts that shape the UX

- F18. `PermissionRequest` input: `session_id, transcript_path, cwd, permission_mode, hook_event_name, tool_name, tool_input, mcp_server?, permission_suggestions[]`. Output: `hookSpecificOutput.decision` with `behavior: allow|deny`, `updatedInput`, `updatedPermissions[]` (`type: addRules|replaceRules|removeRules|setMode|addDirectories|removeDirectories`, `destination: session|localSettings|projectSettings|userSettings`), `message`, `interrupt`. Deny rules in settings still win. **"Always" from the phone is implementable** via `updatedPermissions`.
- F19. Command hooks: default timeout 600 s, per-handler `timeout`; output of a timed-out hook is discarded. HTTP hooks: default timeout 30 s; `ok: false` has no effect on `PermissionRequest`. `onFailure: "block"` denies on `PermissionRequest` (v2.1.295+). Sessions that cannot prompt (non-interactive) **deny** when no hook decides.
- F20. `Notification` input `message, title, notification_type`; `permission_prompt` fires only after ~6 s of an unanswered prompt. So the push trigger must be `PermissionRequest`, not `Notification`.
- F21. `AskUserQuestion` is intercepted in **`PreToolUse`** (`tool_input.questions`) and answered with `permissionDecision: "allow"` plus `updatedInput` carrying questions and answers; "Returning allow alone is not sufficient."
- F22. `WorktreeCreate` / `WorktreeRemove` hooks exist and interplay with `claude remote-control --spawn worktree`.

### 2.5 Coucou (https://github.com/Louis-CFM/coucou — 4,935 stars, MIT code, proprietary name/character/sounds)

- F23. README: hooks via `coucou-hook` over a Unix socket / named pipe; "If Coucou isn't running, the hook exits immediately: **Claude Code is never blocked.**" Approval card Allow (Y) / Deny (N) / Always (Always not for Codex, Copilot, Muse). Question view: single/multi-select, Send/Next, "Other…" free text, "Reply in terminal". Live diffs `+N −M`. Alerts queue one at a time. Supports Claude Code, Cursor, Codex, Gemini CLI, Antigravity, Copilot CLI, Muse Code, OpenCode, Amp, Hermes. Approvals only from Claude Code, Codex, Copilot CLI, Muse Code; Claude Code must be in a mode that asks (auto/bypass never reach the phone).
- F24. iPhone (https://github.com/Louis-CFM/coucou/blob/main/docs/IPHONE.md): link is the user's own iCloud (CloudKit, encrypted), no account, no pairing code; Live Activity via a stateless APNs relay that sees only agent name and state; Face ID on every Allow; "Your Mac only applies a decision meant for the exact command it is waiting on, and a request expires after 2 minutes"; questions arrive as a notification with one button per choice; instruction picked up within 15 s; History grouped by day; Focus filter that only lets approvals and questions through.
- F25. Android (https://github.com/Louis-CFM/coucou/blob/main/android/README.md, https://github.com/Louis-CFM/coucou/blob/main/docs/ANDROID_LINK.md): LAN pairing by QR (`coucou://pair?v=1&host&port&fp&token&name`) with a pinned self-signed certificate, off by default; NDJSON protocol `hello/welcome/sessions/approval/decision/approvalResolved/ping/pong/error`; session `{pillId, agent, state, statusText, stepIndex, stepCount, updatedAt}`; opt-in capabilities `chat`, `details` (last 20 steps ≤200 chars, folder name only, never a full path), `answers` (≤4 questions × 8 options, exact labels, screen lock before answering), `diffs` (≤20 files, 200 lines/file), `usage`, `services`, `prefs`, `relay`; **no "Always" from the phone**; Allow needs biometric/screen lock, Deny does not; taps in the first 600 ms ignored; commands >500 chars → "Command is longer than shown", Deny only; `FLAG_SECURE`; raw tool names become plain words; a command or path is never shown without a deliberate tap; Doze handled by a foreground service + 4-minute alarm heartbeat, FCM deliberately not used; Home says "Connection lost 2 min ago, reconnecting" and why; Settings > Computer > "Can't connect?" diagnostic checklist with a copyable report.
- F26. Internet relay (https://github.com/Louis-CFM/coucou/blob/main/docs/RELAY_LINK.md): optional "Away from home Wi-Fi" mode through the **user's own Cloudflare Worker**; stateless forwarder, the pairing key never reaches the relay, HKDF/AES-256-GCM with counters and padding; no buffering (`{"peer":"offline"}`); "Dropping a decision leaves the approval to expire on the computer, which is not an allow."

### 2.6 Reliability signals (closed issues, cited as history not as current bugs)

- F27. anthropics/claude-code #52084 "Remote Control: approving permission from phone hangs Claude Code on host" (opened and closed 2026-04-22) — https://github.com/anthropics/claude-code/issues/52084
- F28. anthropics/claude-code #62553 "Remote-control: phone-app approval dismisses popup but never reaches local process" (v2.1.150, opened 2026-05-26, closed 2026-06-27, stale) — https://github.com/anthropics/claude-code/issues/62553

## 3. Assumptions

- A1. Remote Control has no "always allow" from the phone and no per-session cost view. Based on absence from the docs (F11, F16), not on testing the product.
- A2. Minimum Claude Code version for Remote Control is ~2.1.52 (third-party blog, unverified); irrelevant to our design beyond "users must be current".
- A3. Web Push to an installed PWA and WebAuthn inside it work on current iOS and Android. Role 5 verifies; this report designs an "open the app" fallback so nothing depends on actionable push buttons.
- A4. A command hook with a long `timeout` can hold a `PermissionRequest` for minutes without side effects; role 4 verifies. If it cannot, the request lifetime in §5.4 shrinks, the UX does not change.
- A5. The second user is a developer with at least one always-on machine, a phone, and Claude Code either on a subscription or on an API key. No non-developer users in the MVP.
- A6. A phone-started session can be made to behave like a terminal session for approvals (real pty, or a hook with a long timeout). If role 4 chooses the SDK, F19 applies: no answer means deny, and the phone must say so.
- A7. Codex and Gemini CLI expose some approval or transcript mechanism (role 4). This report only reserves the adapter boundary.
- A8. The owner carries one phone platform day to day; the other platform is tested by the second user.
- A9. Two `PermissionRequest` hooks (ours and, say, Coucou's) can coexist in one `settings.json`; the precedence semantics are role 4's question. Our installer must add, never replace.

## 4. Findings

### 4.1 "Coucou only works next to the computer or inside one Apple account" — CHANGE

Partly true. iPhone is iCloud-only (F24). Android has an internet relay, but it needs the user's own Cloudflare Worker, has no buffering and is LAN-first (F26). The real gap is narrower than the brief states: **a hosted, zero-deploy relay, both phone platforms, any agent, any auth**. That is a positioning sentence, not a feature list.

### 4.2 "How much of the MVP does Remote Control cover?" — most of it

| MVP item (brief §3) | Remote Control today | Left for remote-control |
|---|---|---|
| 1 Approvals, questions, push | Yes: prompts and questions stay open (F8), push "when actions required" (F7), biometric step-up (F9) | "Always" rule from the phone (A1, F18); per-project push settings; users excluded by F3 |
| 2 Live sessions per project, steps, diffs, last turn | Yes: cross-machine session list, diff pane, subagents (F1, F6) | History and cost (F11, F16); only Claude Code; transcript stored on Anthropic servers (F5) |
| 3a Follow-up instruction | Yes (core feature) | — |
| 3b New session in a chosen repository | Mostly: Desktop folder list + Projects "Work locally" (F12–F13) | Beta, Pro/Max only, auto mode by default, needs the Desktop app running or a server per folder, not with Trusted Devices (F14); no "any allow-listed repo on any machine" from one screen |
| 4 Other agents | No | Entire gap; Channels' permission relay is also Claude-only (F17) |
| Multi-machine | Yes (F1) | Machine health, agent version, permission mode visible |
| Auth coverage | claude.ai subscription only (F3) | API key, Bedrock/Vertex/Foundry, gateways, ZDR (F3) |
| Reliability | Documented process constraints (F4); past approval hangs (F27–F28) | A design where "no answer" can never hang the terminal |

Conclusion: the four MVP items are not where the value is. The value is **the combination** of: any agent × any auth × E2E × Always × start-anywhere. If the owner only needs Claude Code on Pro/Max, Remote Control wins today and this project is a learning exercise (legitimate, but say it).

### 4.3 MVP scope (DECIDED: four items) — CHANGE depth and order, keep the set

- Item 1 and item 3 are the spine: approve, answer, instruct, start. Build them first (M0 → M1).
- Item 2 shrinks to a **thin session view** in M1: state, status sentence, last prompt, step list (tool label + file name), last answer, changed-file names with `+N −M`. Diff bodies move to M2; Remote Control already has a better diff pane and the phone is the wrong place to review 200-line diffs.
- Item 4 stays "after Claude Code" (M2) but the protocol's `agent` field, tool-label dictionary and capability flags exist from M0 so Codex is an adapter, not a rewrite.

### 4.4 Architecture hypothesis (§4) — CONFIRM, with one product invariant added

Relay + outbound agent + PWA is right for "nothing but a browser and an account". Added invariant, taken from Coucou (F23, F26) and from Claude Code's own behavior (F19): **the agent never blocks and never queues decisions.** Hook cannot reach the agent → exit with no decision within ~1 s → terminal prompt. Agent reaches the relay but the phone is silent → hook times out → terminal prompt (interactive) or deny (non-interactive, F19). Decision arrives after expiry or while the agent is offline → dropped, phone told "not delivered".

### 4.5 Hook set (§4) — CONFIRM, two corrections

The listed hooks exist. Corrections: AskUserQuestion goes through `PreToolUse` with `updatedInput` (F21), not `PermissionRequest`; `Notification.permission_prompt` lags ~6 s (F20), so the push is sent from `PermissionRequest`. Prefer a command hook (600 s default timeout) over an HTTP hook (30 s) for the hold (F19). Details: role 4.

### 4.6 WebAuthn on every Allow and every new session — CONFIRM, with the Coucou split

Biometric on **Allow, Always, Start session**. No biometric on **Deny**, **Reply in terminal**, **answering a question**, **follow-up instruction** (Coucou's split, F25; Android asks for screen lock before answers — role 2 may tighten). Rationale: Deny and "hand back to the terminal" are safe directions; friction there makes people choose Allow out of habit.

### 4.7 Project allow-list (§4) — CONFIRM; it is a screen, not a setting

The phone shows **Repositories** per machine, populated only by the agent (`agent repos add <path>` on the computer). The phone can pick, never add. Nothing from the relay can introduce a path (brief §6).

### 4.8 Agent SDK vs CLI (§7.2) — product requirements for role 4

(a) a phone-started session must use the user's **subscription**, not API billing, unless the user explicitly configures an API key; (b) it must be visible and resumable from the terminal (`claude --resume`) so the phone is a starter, not a silo; (c) approvals in it must behave like a terminal session (A6) and the expiry text on the phone must state the consequence: "terminal takes over" vs "denied".

## 5. Recommendations

### 5.1 Positioning

**One inbox for every coding agent on your own machines: approve, answer, instruct and start sessions from your phone, from anywhere, with your transcripts never stored off your machines.**

Target users, in order: the owner; developers on API keys or enterprise gateways (F3 excludes them from Remote Control); developers running two or more agents; privacy-sensitive users. README gets a "Why not Claude Code's Remote Control?" table (the §4.2 table, trimmed) so nobody feels tricked.

Alternatives considered:
- *Use Remote Control and stop.* Right answer for Claude-only Pro/Max users. Rejected only because of items (a)–(f) in §1; revisit under the kill criterion.
- *Build a Channels plugin with the permission relay capability (F17).* Rejected: Claude-only, research preview, needs Bun, claude.ai/Console auth, "anyone who can reply through the channel can approve". Could become a transport later, not a product.
- *One-way notification hook (ntfy-style).* Rejected: no reply path, no E2E, no sessions.
- *Native apps.* Owner decided PWA; this report keeps every flow working with "open the app" so a native wrapper is additive later.

### 5.2 Milestones (what is in, what is out)

| Milestone | In | Acceptance in one line |
|---|---|---|
| **M0 walking skeleton** | Register (passkey), pair one machine, Claude Code `PermissionRequest` → push → Allow/Deny with biometric on Allow, expiry, "Reply in terminal", never-block | Owner approves a real request from mobile data; killing the agent mid-request leaves the terminal prompt usable |
| **M1 MVP** | AskUserQuestion, Always (session destination), follow-up instruction, new session in an allow-listed repo, thin session view, Machine screen with diagnostics, Recent (on phone) | §5.7 success criteria |
| **M2** | Second agent (Codex or Gemini CLI), diff bodies, history per project (7 → 90 days), cost/tokens where the agent exposes them, presence (skip push when at the machine), Always → `projectSettings`, second phone, stop/kill session, worktree option, permission-mode choice at start | Second agent approves from the same inbox; history survives relay restarts |
| **M3** | Native wrapper if role 5 finds PWA limits, lock-screen/Live Activity, shared read-only session link, model/effort control | — |
| **Never** | Character/mascot, island overlay, third-party service cards (GitHub, Vercel, …), chat with a model through the computer's keys, widgets/Siri/Spotlight, LAN direct mode, user-deployed relay, adding repositories from the phone | — |

### 5.3 From Coucou: adopt / drop

Adopt (with source): approval card Allow/Deny/Always with biometrics on Allow only (F24, F25); decision bound to the exact request fingerprint, decide-once, visible expiry (F24, F26); never block the agent (F23); question view with exact labels, single/multi-select, "Other…", "Reply in terminal" (F23, F25); plain-word tool labels, command/path hidden until a deliberate tap, folder name not full path (F25); long command → cannot Allow until fully shown (F25, adapted: we show it scrollable instead of refusing); first-600-ms tap guard (F25); "Connection lost N min ago — why" on Home and "Can't connect?" checklist with a copyable report (F25); Recent decisions kept only on the phone (F25); History grouped by day (F24, M2); opt-in switches per data class on the computer (F25) — we expose them as agent config, default: details on, diffs off.

Drop: Mochi/character and outfits, island overlay, services tab, chat tab, plan-usage cards, widgets/Siri/Control Center/Spotlight, LAN/mDNS pairing and certificate pinning (the relay replaces them), the 120 s expiry (too short for "from anywhere"; see §5.4).

### 5.4 Request lifetime and push policy

- Hold = hook `timeout` − 30 s, default **570 s** (F19). The phone shows a countdown from the agent's `expiresAt`, not from push receipt.
- Phone-started non-interactive sessions (if A6 fails): same hold, expiry text "Denied — nobody answered".
- One push per request: title "`<project>` needs your OK", body = tool label only ("Run a command", "Edit a file"), never the command text (the push payload is built by the relay, which must not see content). Content is fetched E2E when the app opens.
- Push for questions: "`<project>` asks a question". Push for "turn finished": opt-in per project, M1 setting, default off.
- Requests queue in the Inbox; the app shows one card at a time with "1 of 3".

### 5.5 User journeys (MVP, end to end)

Screens are named as in §5.6. Failure states are in *italics*.

**J1 Register.** Welcome → "Create account" → display name → passkey ceremony → Home (empty): "Add your first computer". *No WebAuthn in this browser* → text "Open this page in Safari / Chrome and add it to the Home Screen", nothing else. *Passkey cancelled* → stay on Welcome. Recovery (second passkey or recovery code) is role 2's design; the UI reserves Settings › Account › "Add a passkey".

**J2 Pair the first machine.** Home › "Add a computer" shows: install command (`npx …agent`), then "Scan the code the agent prints, or type it". On the computer the agent prints a QR and an 8-character code (10-minute validity) and waits. Phone scans/types → both sides show the same 4-character check string → user confirms on the phone → agent installs hooks (asks `y/n`, appends, never replaces — A9) → agent sends a **self-test request** ("Test: Allow this to finish pairing") → phone shows the real approval card → Allow (biometric) → agent prints "Paired with <phone name>. Your phone approved the test." → Home shows the machine online with its repositories (none yet) and a hint: `agent repos add <path>`. *Code expired* → "Expired. Run the command again." *Agent cannot reach the relay* → agent prints the reason (DNS, proxy, TLS) and the same text appears nowhere on the phone (the phone just never sees it); phone text after 60 s: "Still waiting for the computer — check its terminal". *No push arrives for the self-test* → phone screen is already open, the card appears via the live connection; afterwards Settings › Notifications shows "Push: not received during setup" with the OS-specific hint (role 5 supplies). *Hooks already contain another tool* → agent says "Keeping existing hooks (<name>); added ours".

**J3 See a session.** Home (Sessions) lists machines → projects → sessions: "kiko · Editing src/… · 2 min ago". Tap → Session: state line, last prompt, steps (tool label + file name, paths on tap), last answer, "Needs you" banner if a request is pending, text field "Next instruction". *Machine offline* → machine row says "offline since 14:02", sessions shown greyed as "last known", all actions disabled with the reason. *Session ended* → "Ended 14:10" + "Start a new session in kiko".

**J4 Push → approve.** Push "kiko needs your OK — Run a command" → tap → app opens directly on Request: project, machine, tool label, "Show command" (tap reveals, scrollable), countdown "Expires in 8:40", buttons Deny · Allow · Always (Always = Allow + rule, only when the agent reports `alwaysSupported`). Allow → biometric → "Sent · Claude continues" → back to Session. Always → biometric → sheet "Allow `npm test` in kiko for this session / this project" (M1: session only) → sent. Deny → optional one-line reason → sent, no biometric. "Reply in terminal" → sent, hook returns no decision, terminal prompt appears. *Request expired before opening* → Request screen shows "Expired 1 min ago — the terminal took over" (or "— denied" per A6), no buttons, link to the session. *Phone was asleep / push delayed* → the Inbox badge and the card are there with the real remaining time; if none, the expired state above. *Agent went offline between push and decision* → "Your computer went offline; the decision was not delivered" — never queued (F26 rule). *Two phones / two taps* → second decision gets "Already decided on <device> at 14:03". *Tap within 600 ms of card appearing* → ignored.

**J5 Answer a question.** Push "syncrona asks a question" → Question screen: header text, one question at a time ("1 of 2"), options with exact labels, single or multi-select, "Other…" free text, Next/Send, "Reply in terminal". Send → delivered as `updatedInput` (F21). *Expired* → same as J4. *Options exceed the display limit* → still rendered, scrollable; nothing truncated silently.

**J6 Send a follow-up.** Session › "Next instruction" → type/dictate → Send (no biometric) → states "Delivered", "Queued — session is busy", "Failed — session no longer accepts input" (mechanism: role 4). *Session ended* → J3 ended state.

**J7 Start a new session.** Home › "+" → Machine (skipped if one) → Repository (from the agent's allow-list, folder names) → Prompt (multiline) → Start (biometric) → Session screen in "Starting…" → first step within 30 s. *Repository list empty* → "Add repositories on the computer: `agent repos add <path>`". *Machine offline* → Start disabled with reason. *Start failed* (claude not found, not logged in, repo missing) → error with the agent's first stderr line, "Retry". *Nobody answers a permission in that session* → per A6 text.

**J8 Lost connection (any screen).** Top banner: "Connection lost 2 min ago — reconnecting" with the reason the phone knows (offline, relay unreachable, signed out). Machine screen › "Can't connect?" runs the checklist: phone online → relay reachable → signed in → machine last seen → agent version → hooks installed (self-reported) → copy report.

### 5.6 PWA information architecture (text wireframes)

Navigation: three tabs — **Inbox**, **Sessions**, **Settings** — plus a "+" action on Sessions. App opens on Inbox when something is pending, otherwise on Sessions. Pushes deep-link to Request/Question. Every list has empty, offline and error states.

```
Inbox (badge = pending)                 Request (deep-linked from push)
┌──────────────────────────────┐        ┌──────────────────────────────┐
│ Inbox                    (2) │        │ ‹ kiko · mac-mini    8:40 ⏱ │
├──────────────────────────────┤        │                              │
│ ● kiko · Run a command  8:40 │        │ Run a command                │
│   mac-mini                   │        │ ┌──────────────────────────┐ │
│ ● syncrona · Question   9:55 │        │ │ Show command             │ │ ← tap reveals,
│   mac-mini                   │        │ └──────────────────────────┘ │   scrollable
├──────────────────────────────┤        │ Suggested rule: npm test *   │ ← from
│ Recent (this phone only)     │        │                              │   permission_suggestions
│ ✓ kiko · Edit a file   14:02 │        │ [ Deny ]  [ Allow ] [Always] │
│ ✗ kiko · Run a command 13:58 │        │        Reply in terminal     │
│ ⏱ kiko · expired       13:40 │        └──────────────────────────────┘
└──────────────────────────────┘        Expired: no buttons, grey text,
 [Inbox●] [Sessions] [Settings]         "the terminal took over".

Sessions (Home)                         Session
┌──────────────────────────────┐        ┌──────────────────────────────┐
│ Sessions                  +  │        │ ‹ kiko · mac-mini            │
├──────────────────────────────┤        │ ▲ Needs you: Run a command   │ ← banner → Request
│ mac-mini · online            │        │ Working · Editing a file     │
│  kiko                        │        ├──────────────────────────────┤
│   ● Working · 2 min ago      │        │ You: "fix the digest test"   │
│   ○ Idle · 1 h ago           │        │ Steps                        │
│  syncrona                    │        │  Read a file  digest.test.ts │
│   ▲ Needs you · 9:55         │        │  Run a command  (tap)        │
│ laptop · offline since 14:02 │        │  Edit a file  digest.ts +3−1 │
│  (last known)                │        │ Claude: "Updated the…"       │
└──────────────────────────────┘        ├──────────────────────────────┤
 [Inbox] [Sessions●] [Settings]         │ Next instruction…     [Send] │
                                        └──────────────────────────────┘

New session (from +)                    Machine
┌──────────────────────────────┐        ┌──────────────────────────────┐
│ ‹ New session                │        │ ‹ mac-mini                   │
│ Computer   mac-mini      ▾   │        │ online · agent 0.3.1         │
│ Repository kiko          ▾   │        │ Claude Code 2.1.3xx · hooks ✓│
│ ┌──────────────────────────┐ │        │ Repositories                 │
│ │ Prompt…                  │ │        │  kiko  syncrona  agenthropic │
│ └──────────────────────────┘ │        │ Sessions ask?  default ✓     │ ← permission_mode
│ [ Start session ] (Face ID)  │        │ Can't connect?  ›            │
└──────────────────────────────┘        │ Unpair this computer         │
                                        └──────────────────────────────┘

Settings: Account (name, passkeys) · Devices (phones, machines) ·
Notifications (per project: approvals ✓, questions ✓, turn finished ☐) ·
Stats (requests, decided here, expired, released) · About.
```

### 5.7 Success criteria

Owner as user #1, measured in the two weeks after M1 from the agent's and phone's local counters (no analytics service):
- ≥ 20 real permission requests decided from the phone while off the home network; ≥ 5 questions answered; ≥ 3 sessions started from the phone; ≥ 1 Always used.
- 0 incidents where a terminal prompt was unreachable because of the agent (the never-block invariant), 0 decisions applied to the wrong request.
- Median push → Request screen ≤ 10 s; expired ratio ≤ 10 % of requests pushed.
- The owner stops approving over SSH when away (self-report, yes/no).

Second user:
- Pairs from the README alone in ≤ 10 min (timestamps: account created → self-test approved).
- Completes one approval and one new session unaided; reports ≤ 2 blocking issues.
- Agent still running 7 days later (Machine screen "last seen").
- Answers "Would you keep it if Remote Control did the same?" — the answer calibrates §4.2, whatever it is.

## 6. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Anthropic adds Always, history or non-Claude agents to Remote Control | Medium | High | Ship M0 in weeks, not months; lead with API-key/gateway users and E2E; kill criterion in §8 Q1 |
| R2 | A decision from the phone hangs or never reaches Claude Code (cf. F27–F28) | Medium | High | Never-block invariant, hook timeout as hard ceiling, expiry countdown from `expiresAt`, "Reply in terminal", three-party E2E test with a fake Claude Code (role 7) |
| R3 | iOS PWA push or WebAuthn limits (role 5) | Medium | Medium | Every flow works by opening the app; push is an accelerator; native wrapper in M3 |
| R4 | Users run in auto/bypass mode and conclude "it doesn't work" | Medium | Medium | Machine screen shows `permission_mode` per session with a hint; self-test at pairing proves the path |
| R5 | Setup friction: editing `settings.json`, keeping the agent alive | High | Medium | `npx …agent init` writes hooks and runs the self-test; daemonisation is role 6; "Can't connect?" checklist |
| R6 | Scope creep toward a chat client or a dashboard | High | Medium | §5.2 "Never" list; thin session view; diffs only in M2 |
| R7 | No second user ever shows up | Medium | Medium | Success criteria require one; recruit before M1, not after |
| R8 | Push leaks content (relay builds the payload) | Low | High | Push carries project + tool label only; content fetched E2E on open (§5.4) |
| R9 | Phone-started sessions deny silently when unanswered (F19) | Medium | Medium | A6: prefer terminal-equivalent sessions; otherwise state "denied if unanswered" on the Start screen |
| R10 | Hook coexistence with Coucou or other hook tools breaks one of them | Low | Medium | Installer appends; role 4 documents precedence; test in CI with two hooks |

## 7. Work items

Sizes: S ≤ half a day, M ≤ 2 days, L ≤ a week. Product-domain items; interfaces to other roles stated.

1. **Positioning section in README** (S; deps: none). Acceptance: README contains the §4.2 table with the six URLs from §2.1–2.3; a reviewer confirms every "Yes" cell against the cited page.
2. **Product vocabulary for `packages/protocol`** (S; deps: role 3 schema owner). Entities: `machine`, `repository`, `session {agent, state, statusText, lastPrompt, lastAnswer, steps[], changedFiles[{name, added, removed}]}`, `request {id, sessionId, toolLabel, toolName, content, suggestions[], expiresAt, alwaysSupported}`, `question {id, questions[{text, options[], multi}]}`, `decision {requestId, behavior: allow|deny|always|terminal, scope?, reason?}`, `instruction`, `startSession {machineId, repositoryId, prompt}`, capability flags per agent. Acceptance: zod schemas exist for each and a test asserts the field list above is a subset.
3. **Screen inventory and routes** (S; deps: none). Acceptance: `docs/product/screens.md` lists every screen in §5.6 with route, data needed, and its empty/offline/error state; no screen lacks one.
4. **Tool-label dictionary** (S; deps: none). Acceptance: unit test: every Claude Code built-in tool name (`Bash, Edit, Write, Read, Glob, Grep, WebFetch, WebSearch, Task, AskUserQuestion, NotebookEdit, MultiEdit`) and `mcp__*` maps to a plain phrase; unknown tools render "Use tool <name>", never raw JSON.
5. **Request lifecycle state machine** (M; deps: 2, role 3). States `pending → decided(allow|deny|always) | released | expired | undeliverable | superseded`. Acceptance: diagram in `docs/product/request-lifecycle.md`; protocol enum matches; table tests cover each transition including "decision after expiry → undeliverable".
6. **Approval card rules and copy** (S; deps: 4, 5). Acceptance: tests: command hidden until tap; Allow disabled while content is truncated; taps < 600 ms ignored; Always button hidden when `alwaysSupported=false`; expired card has no buttons.
7. **Question screen rules** (M; deps: 2; role 4 for `updatedInput` shape). Acceptance: fixture with 4 questions × 8 options renders exact labels, supports multi-select and "Other…", emits the shape role 4 specifies; "Reply in terminal" emits `terminal`.
8. **Onboarding flow with self-test** (M; deps: role 2 pairing, role 4 hook installer). Acceptance: on a fresh machine with a fake Claude Code, a new user reaches "Paired — your phone approved the test" in ≤ 10 min measured by onboarding log timestamps; hooks of another tool are preserved byte-for-byte.
9. **"Reply in terminal" and hold policy** (S; deps: 5, role 4). Acceptance: with hook `timeout` 600, the agent's `expiresAt` = now + 570 s; releasing from the phone makes the fake Claude Code receive an empty hook output within 2 s; stopping the agent makes the hook exit within 1 s.
10. **New-session flow** (M; deps: 2, role 4 spawner, role 2 biometric). Acceptance: E2E with the fake agent: pick machine → repo → prompt → biometric → session appears with state `starting` and a first step within 30 s; a path not in the allow-list cannot be submitted (protocol rejects, UI never offers).
11. **Thin session view** (M; deps: 2). Acceptance: fixture session renders state, last prompt, ≤ 20 steps, last answer, changed files with counts in < 1 s on a mid-range phone; no full path is visible without a tap.
12. **Machine screen and "Can't connect?" checklist** (M; deps: role 3 presence, role 6 agent self-report). Acceptance: each checklist row has a pass/fail and one-line hint; "Copy report" produces text with no secrets (test asserts no token or key material in output).
13. **Local stats counters** (S; deps: 5). Acceptance: Settings › Stats shows requests pushed, decided on this phone, expired, released; a scripted run of 10 requests yields matching counts after app restart.
14. **Second-user usability protocol** (S; deps: 8–12 done). Acceptance: `docs/product/usability-protocol.md` with tasks, timing fields and the questions in §5.7; one filled-in run attached before M1 is declared done.

## 8. Open questions for the owner

1. **Is the overlap acceptable?** Remote Control already does most of the MVP for a Claude-only Pro/Max user (§4.2). Default: proceed for reasons (a)–(f) in §1, with the kill criterion: if Anthropic ships Always-from-phone and a second agent before M1, stop.
2. **Second agent for M2: Codex or Gemini CLI?** Default: whichever role 4 finds has a blocking approval hook; if both, Codex (Coucou supports approvals for it, F23).
3. **Always: which destination in MVP?** Default: `session` only (safe, no files touched); `projectSettings` in M2 behind a setting.
4. **Biometric on every Allow, or a grace window?** Default: every Allow/Always/Start, no grace window in MVP. Revisit with real counts from item 13.
5. **Push on "turn finished"?** Default: off, opt-in per project.
6. **Session view depth in MVP?** Default: thin (no diff bodies) — Remote Control is better at diffs and the phone is not a review tool.
7. **Multi-machine in MVP?** Default: yes for pairing and listing (it falls out of the design); no machine-specific features.
8. **Repository allow-list editable from the phone?** Default: never; only on the computer.
9. **Should a phone-started session that nobody answers be denied or handed to the terminal?** Default: terminal-equivalent (A6); if role 4 says impossible, show "denied if unanswered" on the Start screen.
10. **Who is the second user and when?** Default: one named developer recruited before M1 starts; without one, M1 cannot be declared done.

## 9. Sources

- https://code.claude.com/docs/en/remote-control
- https://code.claude.com/docs/en/claude-projects
- https://code.claude.com/docs/en/desktop
- https://code.claude.com/docs/en/claude-code-on-the-web
- https://code.claude.com/docs/en/channels
- https://code.claude.com/docs/en/hooks
- https://github.com/Louis-CFM/coucou (README; star count and license via the GitHub API on 2026-10-12)
- https://github.com/Louis-CFM/coucou/blob/main/docs/IPHONE.md
- https://github.com/Louis-CFM/coucou/blob/main/android/README.md
- https://github.com/Louis-CFM/coucou/blob/main/docs/ANDROID_LINK.md
- https://github.com/Louis-CFM/coucou/blob/main/docs/RELAY_LINK.md
- https://github.com/anthropics/claude-code/issues/52084
- https://github.com/anthropics/claude-code/issues/62553
- Unverified, listed for completeness (A2): third-party posts claiming Claude Code ≥ 2.1.52 for Remote Control; community hook-based notifiers (e.g. ntfy-style "remote approver" scripts).
