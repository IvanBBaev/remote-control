# Screen inventory

Every PWA screen with its route, the data it needs, and its empty, offline and error
states (01 W3, 01 §5.6, 05 Rec-3, 05 Rec-7). The route table lives in
`apps/web/src/routes.tsx`; a screen marked _planned_ has no route yet.

Conventions:

- **Offline** means the relay WebSocket is down. Lists keep showing the last known data
  with an "Offline — showing what this phone last saw" notice; actions that need the relay
  are disabled with that reason next to them. Nothing is queued silently.
- **Error** means a request failed. The screen shows one sentence on what failed and a
  "Try again" button; nothing is lost from the screen.
- Empty, offline and error states share one look: the notice block (`.notice`).
- Navigation after onboarding: tabs **Sessions** and **Computers** today; **Inbox** and
  **Settings** join when their screens land (01 §5.6 lists Inbox, Sessions, Settings).

## Onboarding

The gate (`apps/web/src/onboarding.ts`) sends the user to the first unmet step, in the
order passkey → install → notifications → pair (05 Rec-3). The main app is reachable only
when every step is done; a step out of order redirects to the current one.

| Screen                         | Route                                                                        | Data needed                                                                                                                                                                                                                                                                                                                                                               | Empty                                    | Offline                                                                                                    | Error                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Update your browser            | `/onboarding/update-browser`                                                 | Capability report: missing capabilities                                                                                                                                                                                                                                                                                                                                   | — (shown only when something is missing) | Works offline: the probe is local                                                                          | — (no requests)                                                                                                                                                                                                                                                                                                                                                                                                           |
| Create your passkey            | `/onboarding/passkey`                                                        | Invite code (typed, or `?invite=` from the invite link), optional display name; relay RP ID                                                                                                                                                                                                                                                                               | —                                        | "You are offline — connect to create your passkey"; button disabled                                        | WebAuthn cancelled or failed: "Passkey not created — try again"; relay rejected the invite: "This invite code is not valid"; rate limited: "Too many attempts — wait a minute and try again"                                                                                                                                                                                                                              |
| Save your recovery code        | `/onboarding/passkey` (after registration)                                   | Recovery code from the registration response, shown once (D8)                                                                                                                                                                                                                                                                                                             | —                                        | Works offline: nothing is sent                                                                             | — (no requests). "Continue" stays disabled until "I saved my recovery code somewhere safe" is checked                                                                                                                                                                                                                                                                                                                     |
| Install the app                | `/onboarding/install`                                                        | Capability report: verdict, standalone                                                                                                                                                                                                                                                                                                                                    | —                                        | Works offline: instructions only                                                                           | — (no requests). Shows "Continue in the browser" only where push already works (Android, desktop)                                                                                                                                                                                                                                                                                                                         |
| Turn on notifications          | `/onboarding/notifications`                                                  | `Notification.permission`; push subscription (push WP)                                                                                                                                                                                                                                                                                                                    | —                                        | Permission can be granted offline; the subscription upload waits for the relay and says so                 | Denied: "Notifications are blocked — allow them in your phone's settings"; unsupported: "This browser cannot show notifications. Install the app first."                                                                                                                                                                                                                                                                  |
| Add your first computer (Pair) | `/onboarding/pair` (title "Add a computer" once paired, back to `/machines`) | Step 1: computer name → one-time `npx remotectl login <token>`; step 2: scan the `rc1:` QR `npx remotectl pair` draws (camera, M2-04; shown only where the browser has a camera) or type its 12-character code → handshake → "Check the code" with the fingerprint both screens show; "The codes match" saves the pairing and opens Computers, Cancel discards it (M0-20) | —                                        | "You are offline — pairing needs a connection."; Pair, Scan the QR code and Get the login command disabled | "That code is not valid…", "That code has expired…", "That code was already used…" (run `npx remotectl pair` again), "Too many attempts…", "Your computer did not answer…", "Not connected…", "Could not create the login command", "Could not save the pairing on this phone"; scan: "Camera access is blocked…", "The camera could not start…", "That is not a pairing QR code…", "That QR code is for another server…" |

## Signed out

| Screen  | Route    | Data needed                                                                                                    | Empty | Offline                                                 | Error                                                                                                                                                                                                                      |
| ------- | -------- | -------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign in | `/login` | Relay RP ID; passkey assertion from the button or from the autofill list of the account field (conditional UI) | —     | "You are offline — connect to sign in"; button disabled | Assertion cancelled: stays on the screen; unknown passkey: "This passkey is not registered here — create an account"; rate limited: "Too many attempts — wait a minute and try again"; other: "Sign-in failed — try again" |

### End-to-end hooks (P1, wired in M1-12)

Playwright spec P1 (register + login with the CDP virtual authenticator) drives these
screens through their accessible names, which are part of the screen contract:

- Register: open `/onboarding/passkey?invite=<code>`, press **Create passkey**, read the
  code from the element labelled **Recovery code**, check **I saved my recovery code
  somewhere safe**, press **Continue**.
- Login: open `/login`, press **Sign in with passkey**; the conditional-UI path focuses
  `#login-username` (`autocomplete="username webauthn"`).
- The virtual authenticator must report user verification (`isUserVerified: true`):
  registration, login and decision assertions all require UV.

## Main app

| Screen               | Route                                          | Data needed                                                                                                                                                                                                    | Empty                                                                                                                                                                  | Offline                                                                                                         | Error                                                                                                                                                                                                      |
| -------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions (home)      | `/sessions` (also `/`)                         | Machines with online state; sessions per machine with state (working, idle, needs you) and last activity                                                                                                       | "No sessions yet. Start one here or run an agent on a paired computer." + New session                                                                                  | Last known list with "offline since" per machine; New session disabled                                          | "Could not load sessions" + Try again                                                                                                                                                                      |
| Session              | `/sessions/:id`                                | Session header (project, machine), "needs you" banner, transcript steps (decrypted on the phone), state                                                                                                        | "Nothing has happened in this session yet"                                                                                                                             | Last known transcript; compose box disabled with "Offline"                                                      | Unknown id: "This session no longer exists" + back to Sessions; decrypt failure: "Could not read this session on this phone"                                                                               |
| Approval request     | `/requests/:id`                                | Request (plain tool label, content hidden behind "Show command" / "Show file" / … until tapped), local deadline from `ttlMs`, machine name and project folder name (see "Approval card rules")                 | Unknown id (a push carries the doorbell id, D5): goes to the most urgent pending request; none: "Nothing is waiting for you." ("Connecting…" while the socket is down) | Deny/Allow answer "You are offline. Nothing was sent."; a sent decision waits in the outbox for the session     | Countdown hits zero or the agent expires it: "Expired. The terminal is asking again."; decided elsewhere: the outcome; refused by the computer or the relay: the reason; truncated content: Allow disabled |
| Question             | `/requests/:id` (same route, `kind: question`) | `Question` (1–4 questions, each with 2–4 options, optional header and option descriptions, multi-select flag), local deadline from `ttlMs`, machine name and project folder name (see "Question screen rules") | As Approval request                                                                                                                                                    | Send answer/Deny answer "You are offline. Nothing was sent."; a sent answer waits in the outbox for the session | As Approval request; an answer the computer cannot use: "Your computer could not use that answer. Answer it in the terminal."                                                                              |
| New session          | `/new`                                         | Paired machines (online), repositories per machine, prompt                                                                                                                                                     | No computer: "Pair a computer first" + link to pairing                                                                                                                 | Start disabled: "Offline"                                                                                       | Machine refused or went offline: "The computer did not start the session" + Try again                                                                                                                      |
| Computers (machines) | `/machines`                                    | Paired machines sorted by name: online state or "last seen"; the computer's history per repository (M2-06); this phone's counters per computer and project; Add a computer                                     | "No computers yet" + Add your first computer                                                                                                                           | Last known list, marked offline                                                                                 | "Could not load computers" + Try again                                                                                                                                                                     |
| Page not found       | any other path                                 | —                                                                                                                                                                                                              | —                                                                                                                                                                      | Works offline                                                                                                   | —                                                                                                                                                                                                          |

### Notifications and launch (M0-21)

- A push whose sealed summary opens with one of the phone's notification keys (M1-06)
  shows "<project>: <tool label>" over the summary line, tagged and linked by the request
  id. Otherwise it shows "Approval needed on <computer>" / "Tap to review." with the
  doorbell id as its tag; a malformed payload still shows a generic "Approval needed"
  (iOS revokes push for a push without a notification).
- Turn notices (M2-08) are off by default and set per machine in the agent's config
  (`notifications.turnFinished` for Claude Code's `Stop`, `notifications.needsInput` for
  its `agent_needs_input` notification); iOS shows every push, so the agent filters, not
  the phone. The agent pushes one only to phones without a live session, only when it
  can seal the summary, deliverable for 15 minutes. It shows "<project>: Turn finished"
  / "Tap to open." or "<project>: Needs your input" over Claude Code's masked message
  line, and a tap opens the app root. A phone that cannot open the summary falls back to
  the generic "Approval needed" notification.
- A tap focuses an open app and posts `{ t: 'navigate', url }`, or opens `/requests/<id>`.
- Within 10 s of launch or of returning to the foreground, a pending request opens by
  itself, once; the home-screen badge shows the number of pending requests.
- Deny, Allow and Reply in terminal ignore taps in the first 600 ms after the card
  appears; Allow asks for the passkey (D7).

### Approval card rules (M1-11, 01 W4/W6)

- The headline is a plain label from `toolLabel` in `@remote-control/protocol`: every
  Claude Code built-in tool has one ("Run a command", "Edit a file", "Fetch a web page",
  …); an MCP tool is labelled by its server ("github: create issue"); an unknown tool
  falls back to "Use tool <name>", never to JSON.
- Under the computer's name the card shows the project: the folder name of the session's
  working directory (D21, never the full path). It travels only inside the sealed
  session (`ApprovalRequest.project`); a push still carries the label only (D5).
- The command, path or other content is never on screen before a deliberate tap. The
  button names what it reveals by the tool's kind: "Show command", "Show file",
  "Show search", "Show address", otherwise "Show details". The revealed block shows the
  raw tool name and the full content and scrolls inside the card when it is long.
- Truncated content: Allow and every "Always" button are disabled and the card says to
  answer in the terminal; Deny stays available.
- "Always (this session)" (M1-02, D24) appears only when `alwaysSupported`: the agent
  offers it when Claude Code suggested allow rules, and the card lists every rule it
  grants ("Always allow in this session:" with `Bash(npm test)`-style labels). It asks
  for the same user-verifying passkey as Allow; the agent re-targets every rule to
  `destination: "session"`, so nothing is written to a settings file.
- Settings destinations (M2-07, D24): the agent's local `always.destinations` config
  (default `['session']`, must include `session`) may add `localSettings` and/or
  `projectSettings`. Only then does the request carry `alwaysDestinations` and the card
  show one button per destination — "Always (this session)", "Always (this project,
  only me)", "Always (this project, everyone)" — under the heading "Always allow:". The
  chosen destination is signed in the decision `payload` (`null` = session); the agent
  rejects a destination outside its config as `wrong_kind` and emits nothing.
- Taps in the first 600 ms are ignored; an expired, decided or refused card has no
  Deny/Allow/Always buttons.

### Question screen rules (M1-01, 04 §2.3)

- Claude Code's `AskUserQuestion` opens at `/requests/:id` with the title "Question";
  the agent only sends it when it fits the phone (1–4 questions, 2–4 options each,
  distinct question texts), otherwise the terminal keeps it.
- One question per step: the optional header, the question text, then the options with
  their descriptions (linked to the input by `aria-describedby`). Single-select uses
  radio buttons, multi-select checkboxes with "Choose one or more.". Every option row is
  at least 44 px tall.
- "Other" is always offered and reveals a text field ("Your answer"); blank text does
  not count. For a single-select question it replaces the picked option, for a
  multi-select one it is added after the picked labels.
- Back / Next move between questions (Next is disabled until the step is answered); the
  last step adds an optional "Note for the agent", sent as the free-text `response`.
- "Send answer" is enabled once every question is answered and always asks for the
  passkey with user verification: the answer is the decision's signed payload (D7).
  Deny needs no passkey and ends the question with a `PreToolUse` deny. Taps in the
  first 600 ms are ignored; an expired, answered or refused question has no buttons.
- Answers are not counted as approvals or denials in the local counters; the asking
  session is.

### Reply in terminal and pause (M1-03, D10)

- The approval card and the question screen both offer "Reply in terminal" (a full-width
  44 px target under Deny/Allow, or under Deny on a question). It needs no passkey:
  it is a sealed `terminal` decision the relay only routes, and it never grants
  anything. The same 600 ms tap guard applies.
- The agent hands the request straight back to Claude Code's own prompt (the empty
  handoff `{}`): it is neither an approval nor a denial, and neither side counts it.
  While it travels the card says "Reply in terminal sent. Waiting for your computer…";
  once the computer accepts it the card shows "Handed back to the terminal. Answer it on
  your computer." without buttons or a countdown. Other phones show the same text
  (`resolved` with outcome `terminal`, D25) and a later decision is `already_resolved`.
- `remotectl pause [--for 30m|2h|1d]` hands every blocking hook straight back to the
  terminal with nothing sent to the phones (no request, no push) until
  `remotectl resume` or the expiry; requests already held when the pause starts are
  released within a second and the phones see the same "Handed back to the terminal."
  outcome. `remotectl status` prints `pause: paused` or `pause: paused until <time>`.
  The running agent picks the switch up without a restart (`pause.json` in the data
  directory, 0600, written atomically).

### Local counters (M1-11, M2-06, 01 W13)

- Counted per computer and per project folder name, kept on the device that counted them
  and never sent to the relay or to any analytics service (I1/I3). The agent's counters
  reach a phone only inside its end-to-end session.
- Phone (`localStorage`, shown on Computers as "From this phone: N approved, N denied,
  N sessions" plus one line per project): approvals and denials this phone sent and the
  computer accepted, and distinct agent sessions that asked this phone. A request the
  agent sends again is not counted twice.
- Agent (`stats.json` version 2 in the data directory, 0600 in a 0700 directory, written
  atomically; a version 1 file is upgraded in place): approvals and denials applied from
  a phone, new Claude Code sessions (`SessionStart` with source `startup`), completed tool
  calls (`PostToolUse`), active time (each turn from `UserPromptSubmit` to `Stop` or
  `SessionEnd`; a turn in progress while the agent restarts adds no time) and the last
  activity. `remotectl status` prints them as `local counters:` with one line per
  project. Token and cost totals are not counted: Claude Code's `Stop` payload carries no
  usage.
- History on the phone (M2-06): the agent sends its counters as a `history` message
  (at most 200 projects, most recently active first) after every snapshot and whenever a
  turn ends or a decision is counted. Computers shows them under "On this computer:", one
  line per repository — sessions, tool calls, active time, approved, denied and "last
  active … ago" in relay time. The phone keeps them in memory only.

### New session and follow-up (M1-04, D7)

- New session (`/new`) picks a paired computer (the first online one by default; others
  read "(offline)"), one of the folders on that computer's allow-list (`repositories` in
  its remotectl config, sent in the snapshot) and a prompt of at most 16,384 characters.
  Folders show by name; "Show path" reveals the full path. The phone only picks; it never
  edits the list. No folders: "No folders are allowed on this computer yet. Add them
  under "repositories" in its remotectl config." Offline: "Offline. Start is available
  when the computer is online." Start stays disabled until a folder and a non-blank
  prompt are chosen and while an earlier start is unanswered.
- Start and Send each ask for the passkey (D7) and carry a signed decision (`kind`
  `start` over the repository id, `instruct` over the text) with a fresh request id.
  While the computer has not answered: "Sent. Waiting for your computer…".
- Outcomes: accepted start "Session started." with "Open the session" when the agent
  names the session; accepted follow-up "Sent to the session."; `not_allowed` "That folder
  is not on your computer's allow-list. Nothing was started."; `start_failed` "The
  computer did not start the session. Try again."; `follow_up_unsupported` "This session
  cannot take instructions from the phone. Continue it in the terminal."; `unsupported`
  "Your computer's remotectl cannot do this yet. Update it and try again."; `expired` /
  `too_late` "Too late: it took too long to reach your computer. Try again."; not
  delivered before its expiry "Not delivered in time. Nothing was sent."; a relay
  refusal "The relay refused it. Try again."
- Session (`/sessions/:id`) shows the CLI's session name (else "Session"), the state and
  status line, the live feed (below), and the compose box. The box is enabled only when the agent marks the
  session `followUp` (a background session) and the computer is online; otherwise it is
  disabled with "This session runs in a terminal. Continue it there.", "This session has
  ended." or "Offline.". Unknown id: "This session no longer exists." ("Connecting…"
  before the first connection).

### Sessions and the live feed (M1-05, D21)

- Sessions (`/sessions`) groups the sessions of the latest snapshots by computer (sorted
  by name; computers without sessions are left out). Each row links to the session and
  shows its name (else "Session"), a state badge (Starting, Working, Needs you, Idle,
  Ended) and the status line (what it waits for, e.g. "Waiting for approval").
- Session (`/sessions/:id`) adds the thin view under the state line: the last prompt,
  the steps of the current turn (at most 20), the changed files and the last answer.
  A changed file shows its file name and `+N −M`; a tap shows the full path. There are
  no diff bodies anywhere (D21). With none of these: "Nothing has happened in this
  session yet."
- The agent builds the content from `UserPromptSubmit`, `PostToolUse`, `Stop`,
  `SubagentStop`, `PreCompact` and `Notification` hooks and sends each as a sealed
  `event` message with a per-session `seq`. A snapshot carries the content with
  `feedSeq` (the last event it includes); the phone applies only events with a larger
  `seq`. Every message fits in one frame (`MAX_MESSAGE_BYTES`): events are capped per
  field, and a snapshot too large drops the largest sessions' content first (they stay
  listed), then trailing sessions.

## Planned (no route yet)

| Screen   | Route (planned) | Data needed                                                                                              | Empty                         | Offline                                                       | Error                                                     |
| -------- | --------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------- | --------------------------------------------------------- |
| Inbox    | `/inbox`        | Pending requests and questions (badge count); recent decisions kept on this phone                        | "Nothing needs you right now" | Pending list as last seen, marked offline; decisions disabled | "Could not load the inbox" + Try again                    |
| Machine  | `/machines/:id` | Machine name, online state, agent and Claude Code versions, hooks status, repositories, permission mode  | "No repositories seen yet"    | Last known details, marked offline                            | Unknown id: back to Computers; "Can't connect?" checklist |
| Settings | `/settings`     | Account (name, passkeys), devices (phones, machines), notification preferences per project, stats, about | —                             | Read-only, marked offline                                     | "Could not save" + Try again                              |
