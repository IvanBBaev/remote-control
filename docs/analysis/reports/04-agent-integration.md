# 04 — Agent integration: Claude Code hooks, SDK vs CLI, sessions, Codex / Gemini

Status: 2026-10-12. Role #4 (agent-integration engineer). Input: `00-brief.md`,
current vendor documentation (URLs in §9), the owner's `agenthropic` repository,
and read-only checks of the local `~/.claude`. Everything in §2 was read on the
cited page today; everything that was not is in §3.

## 1. Summary

1. Claude Code via **hooks only**: blocking `PermissionRequest` (raised `timeout`)
   and `PreToolUse:AskUserQuestion`; non-blocking `PostToolUse`, `Stop`,
   `SubagentStop`, `Notification`, `UserPromptSubmit`, `Session*`, `PreCompact` for the feed.
2. Hook command = **our own `hook.js`** with a per-install 0600 token, loopback
   POST; fails **open to the terminal prompt**, never to "allow". No `http` hooks.
3. New session = `claude --bg`; follow-up = `claude --resume <uuid> --bg` (v2.1.257+);
   registry = `claude agents --json` — the user's own CLI and subscription. Agent
   SDK = API-key-only by policy → optional adapter later. No tmux.
4. **Remote Control** is relay-only, no local API, cannot be built upon; it coexists
   with our hooks and already covers MVP 1–3 for Pro/Max Claude-Code-only users.
5. Live feed from **hook payloads**; transcript parser only as flagged backfill.
6. **Codex**: full adapter via its official `PermissionRequest`/`PreToolUse` hooks
   (phase 2). **Gemini**: observe + deny gate only.
7. Home agent = loopback Fastify receiver + pending store + session registry +
   outbound relay client, behind an `AgentAdapter` port.

## 2. Verified facts

Abbreviations for sources (full URLs in §9): H = hooks reference, HG = hooks
guide, HL = headless, SE = sessions, AV = agent view, RC = remote control, SDK-O/
SDK-TS/SDK-UI/SDK-P/SDK-S = Agent SDK pages, GEM = Gemini hooks reference,
CDX-H / CDX-C = Codex hooks / config pages.

### 2.1 Claude Code hooks — general contract (H, HG)

- 33 hook events exist; the TypeScript union in SDK-TS lists them: `PreToolUse`,
  `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`,
  `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart`, `SessionEnd`, `Stop`,
  `StopFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`,
  `PreModelSwitch`, `PostModelSwitch`, `PermissionRequest`, `PermissionDenied`,
  `Setup`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`, `Elicitation`,
  `ElicitationResult`, `ConfigChange`, `DirectoryAdded`, `WorktreeCreate`,
  `WorktreeRemove`, `InstructionsLoaded`, `CwdChanged`, `FileChanged`, `MessageDisplay`.
- Hook types: `command`, `http`, `mcp_tool`, `prompt`, `agent`. `SessionStart` and
  `Setup` accept only `command` and `mcp_tool` hooks (no `http`).
- Common input (stdin JSON): `session_id`, `transcript_path`, `cwd`,
  `permission_mode`, `hook_event_name`; tool events add `tool_name`, `tool_input`,
  `tool_use_id`; `prompt_id` is present on turn-scoped events. Example (H):
  ```json
  {"session_id":"abc123","prompt_id":"...","transcript_path":"/Users/.../.claude/projects/.../00893aaf-....jsonl",
   "cwd":"/Users/...","permission_mode":"default","hook_event_name":"PreToolUse",
   "tool_name":"Bash","tool_input":{"command":"npm test"},"tool_use_id":"toolu_01ABC123..."}
  ```
- Output: exit 0 + optional JSON on stdout; exit 2 = block (stderr is the reason)
  where the event supports blocking; other exit codes = non-blocking error.
  Common JSON fields: `continue`, `stopReason`, `suppressOutput`, `systemMessage`,
  `decision`/`reason` (legacy), `hookSpecificOutput`.
- Timeouts: per-hook `"timeout"` in seconds. Defaults: 600 s for `command`/`http`/
  `mcp_tool`; 30 s on `UserPromptSubmit`/`PreModelSwitch`/`PostModelSwitch`; 10 s
  on `MessageDisplay`; `prompt` 30 s; `agent` 60 s; `SessionEnd` 1.5 s budget
  (raisable to 60 s). **No documented maximum**; a timed-out hook is a
  non-blocking error (proceeds as if the hook returned nothing).
- `"onFailure": "block"` (v2.1.295+) turns a hook error/timeout into a block.
- `"async": true` hooks cannot block or decide anything; their output is delivered
  on the next turn (`asyncRewake` + exit 2 wakes an idle session). `"if"` applies
  to tool events only. Settings changes are picked up live (`ConfigChange` hook).
- Matchers: regex on `tool_name` (tool events), `notification_type`
  (`Notification`), `source` (`SessionStart`), `trigger` (`PreCompact`).
- Workspace trust: an **interactive** session holds back hooks from every
  settings file, including `~/.claude/settings.json`, until the folder (or a
  parent) is trusted; `-p`/SDK sessions treat the folder as trusted.
  `--settings '{"disableAllHooks": true}'` disables hooks for one run.

### 2.2 `PermissionRequest` (H)

- Fires only when Claude Code is **about to show a permission prompt** (or would
  auto-deny because it cannot prompt). Permission rules, permission mode and
  `PreToolUse` decisions run first; an allowed tool never reaches this hook.
- Input adds `tool_name`, `tool_input`, `permission_suggestions` (no `tool_use_id`):
  ```json
  {"session_id":"abc123","transcript_path":"...","cwd":"/Users/...","permission_mode":"default",
   "hook_event_name":"PermissionRequest","tool_name":"Bash",
   "tool_input":{"command":"rm -rf node_modules","description":"Remove node_modules directory"},
   "permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"rm -rf node_modules"}],
                              "behavior":"allow","destination":"localSettings"}]}
  ```
- Output: `hookSpecificOutput.decision` with `behavior` `allow`|`deny`, optional
  `updatedInput`, `updatedPermissions` (same shape as `permission_suggestions`),
  `message` (deny reason shown to Claude), `interrupt` (deny + stop the turn):
  ```json
  {"hookSpecificOutput":{"hookEventName":"PermissionRequest",
    "decision":{"behavior":"allow","updatedInput":{"command":"npm run lint"}}}}
  ```
  ```json
  {"hookSpecificOutput":{"hookEventName":"PermissionRequest",
    "decision":{"behavior":"deny","message":"Denied from phone","interrupt":false}}}
  ```
- Exit code 2 is **not** honored for this event. A hook that returns no decision
  (empty output, timeout, error) lets the normal prompt appear; in a session that
  cannot prompt (`-p` without a permission host) the request is **denied**.
- It runs in `-p` mode too, except under `dontAsk`. Background sessions run it:
  AV states a background session waiting on a permission decision reports a
  `PermissionRequest`/`PreToolUse` hook's invalid output on its row (v2.1.248+).

### 2.3 `PreToolUse` and answering `AskUserQuestion` (H, SDK-UI)

- Output `hookSpecificOutput.permissionDecision`: `allow` | `deny` | `ask` |
  `defer`; precedence across hooks `deny > defer > ask > allow`. `updatedInput`
  **replaces the whole** `tool_input`. `defer` works only in `-p` with a single
  tool call (process exits with `stop_reason: "tool_deferred"`; resume later with
  `claude -p --resume`).
- `AskUserQuestion` is a tool call, so a `PreToolUse` hook with matcher
  `AskUserQuestion` sees its `questions` and can answer by returning `allow` with
  `updatedInput` carrying `answers` (question text → chosen label):
  ```json
  {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow",
    "updatedInput":{"questions":[{"question":"Which framework?","header":"Framework",
      "options":[{"label":"React","description":"Component library"},{"label":"Vue","description":"Progressive framework"}],
      "multiSelect":false}],"answers":{"Which framework?":"React"}}}}
  ```
  1–4 questions, 2–4 options each, optional free-text `response`; not available
  in subagents; `--permission-prompts none` removes the tool (HL).

### 2.4 Non-blocking events used for the live view (H, AV)

- `Notification` cannot block. Input: `message`, `title`, `notification_type`;
  types include `permission_prompt` (fires ~6 s after the prompt is shown, i.e.
  **after** a `PermissionRequest` hook returned without a decision), `idle_prompt`
  (~60 s idle), `agent_needs_input`, `agent_completed` (background sessions, AV
  v2.1.198+), elicitation and quota types.
  ```json
  {"session_id":"abc123","transcript_path":"...","cwd":"/Users/...","hook_event_name":"Notification",
   "message":"Claude needs your permission","title":"Permission needed","notification_type":"permission_prompt"}
  ```
- `Stop` input: `stop_hook_active`, `last_assistant_message`, `background_tasks[]`,
  `session_crons[]`. `SubagentStop` adds `agent_id`, `agent_type`,
  `agent_transcript_path`. Both can block (exit 2 / `decision: "block"`) — we never do.
- `PostToolUse` carries `tool_input` and `tool_response` (for `Edit`/`Write` this
  is the file change itself). `UserPromptSubmit` carries `prompt`. `SessionStart`
  carries `source` (`startup`/`resume`/`clear`/`compact`); `SessionEnd` carries
  `reason`.

### 2.5 `http` hooks and settings (H, ST)

- `http` hooks POST the same JSON; 2xx + JSON body = decision; non-2xx or a
  connection failure = non-blocking error. URLs must be in `allowedHttpHookUrls`;
  headers may expand env vars listed in `httpHookAllowedEnvVars`.
- Hooks from user, project, local and managed settings are all loaded; matching
  hooks run in parallel; the most restrictive decision wins; settings are
  re-read on change.

### 2.6 Sessions and transcripts (SE)

- Transcripts: `~/.claude/projects/<project>/<session-id>.jsonl`, `<project>` =
  cwd with non-alphanumerics replaced by `-`; names over 200 chars are truncated
  and suffixed with a hash. `CLAUDE_CONFIG_DIR` moves the root;
  `CLAUDE_CODE_PROJECT_DIR_NAME` (v2.1.234+, only with `CLAUDE_CONFIG_DIR`) pins
  the project name. Retention `cleanupPeriodDays` (30 default).
- "The entry format is internal to Claude Code and changes between versions, so
  scripts that parse these files directly can break on any release." The page
  recommends hooks' `transcript_path`, `claude -p --output-format json`, or the SDK.
- `claude --resume <session-id>` works from any directory (current project +
  worktrees first, then all projects if exactly one holds it). Resuming one
  session in two terminals interleaves both into one transcript. `-p`/SDK
  sessions are hidden from the picker and `--continue` (`claude -p --continue`
  includes them).

### 2.7 Headless `claude -p` (HL)

- `-p` is "the Agent SDK via the CLI". `--output-format stream-json`
  (`--include-partial-messages` for deltas), `--input-format stream-json`,
  `--resume <id>` / `--continue`, `--permission-prompt-tool <mcp tool>` (a host
  that answers permission requests), `--permission-prompts none` (v2.1.259+:
  anything unresolved is denied, `AskUserQuestion` removed), `--permission-mode`,
  `--allowedTools`, `--bare`.
- `--bare` "doesn't use your subscription login" and needs `ANTHROPIC_API_KEY`;
  a non-bare `-p` run loads `~/.claude` hooks and credentials like an interactive
  session. SIGTERM → exit 143, `SessionEnd` hooks still run.
- `claude -p --resume <id> "prompt"` typed at a TTY attaches to a **running
  background** session; with piped I/O it sends nothing and exits 1.

### 2.8 Background sessions and agent view (AV, SE) — research preview

- `claude --bg "<prompt>"` dispatches a full session under a separate supervisor
  process (roster in `~/.claude/jobs/`, **not a stable interface**); it runs in
  the dispatch directory with its settings and outlives the terminal. `--bg`
  with `-p` is rejected; an untrusted directory fails `Workspace not trusted`.
- `claude --resume <full-uuid> --bg "<prompt>"` continues **that** session under
  its own ID (v2.1.257+; earlier versions silently forked). `--continue`, bare
  `--resume`, or `--resume <name>` with `--bg` always start a copy.
- An undeliverable reply is saved and sent as the next prompt (v2.1.208+); a peek
  reply runs when the current turn ends (v2.1.287+); a reply never answers a
  permission dialog — only a hook or an attached terminal does.
- `claude agents --json [--all] [--cwd <dir>]`: `cwd`, `kind` (`interactive` |
  `background`), `startedAt`, `id`, `state` (`working`|`blocked`|`done`|`failed`|
  `stopped`), `pid`, `status` (`busy`|`waiting`|`idle`), `waitingFor`
  (`permission prompt` | `input needed` | `sandbox request` | `worker request` |
  `dialog open`), `sessionId` (full UUID), `name`.
- `claude attach|logs|stop|rm <id>`; opt out with `disableAgentView`. `--name`
  / `/rename` set a resumable name (default display name `<dir>-xx` is not one).

### 2.9 Claude Agent SDK (SDK-O, SDK-TS, SDK-UI, SDK-P, SDK-S)

- `@anthropic-ai/claude-agent-sdk`: `query({ prompt: string |
  AsyncIterable<SDKUserMessage>, options })` → `Query` (async generator plus
  `interrupt()`, `setPermissionMode()`, `streamInput()`, `close()`). Options:
  `cwd`, `permissionMode`, `canUseTool`, `hooks` (`{ matcher?, hooks:
  HookCallback[], timeout? }`), `resume`, `forkSession`, `continue`,
  `includePartialMessages`, `settingSources` (`[]` = none), `allowedTools`,
  `permissionPrompts` (`'host'|'none'`), `persistSession`, `pathToClaudeCodeExecutable`.
- `canUseTool(toolName, input, { signal, suggestions })` → `{ behavior: "allow",
  updatedInput, updatedPermissions? }` | `{ behavior: "deny", message }`; may stay
  pending indefinitely. Order: hooks → deny → ask → mode → allow → `canUseTool`.
  `AskUserQuestion` is answered with `updatedInput = { questions, answers }`.
- Session helpers: `listSessions()`, `getSessionMessages()`, `getSessionInfo()`;
  cross-directory resume v2.1.223+. `apiKeySource` on the init message:
  `ANTHROPIC_API_KEY` | `apiKeyHelper` | `/login managed key` | `none`.
- SDK-O: Anthropic **does not allow third-party developers to offer claude.ai
  login or its rate limits in products built on the SDK**; SDK products use an
  API key (or a cloud provider).

### 2.10 Claude Code Remote Control (RC)

- Start: `claude remote-control` (server mode; `--name`, `--session-id`, `-c`,
  `--spawn same-dir|worktree|session`, `--capacity`, `--permission-mode`, `-d`),
  `claude --rc [name]`, `/rc` inside a session; `/config` "Enable Remote Control
  for all sessions" and "Push when actions required".
- Requires a claude.ai login on Pro/Max/Team/Enterprise; API keys,
  `ANTHROPIC_AUTH_TOKEN`, `apiKeyHelper`, and `ANTHROPIC_BASE_URL` gateways are
  **not supported**.
- Transport: outbound HTTPS polling of the Anthropic API; no inbound port, **no
  local API documented**; one remote session per interactive process. Permission
  prompts and `AskUserQuestion` stay open; other dialogs expire after 5 min;
  server mode stops reconnecting after ~10 min offline; resume within ~4 h.

### 2.11 Codex CLI (CDX-H, CDX-C)

- Hooks are on by default (`[features] hooks = false` disables). Config:
  `~/.codex/hooks.json` or `[hooks]` in `~/.codex/config.toml`; project
  `.codex/hooks.json` only when trusted. **Non-managed hooks must be trusted
  with `/hooks` in the CLI before they run** (`--dangerously-bypass-hook-trust`
  skips it per invocation).
- Events: `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`,
  `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`,
  `PreCompact`, `PostCompact`, `Stop`, `Interrupt`. No `Notification`.
- Input: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`
  (+ `turn_id`, `permission_mode` on some); tool events add `tool_name`,
  `tool_use_id`, `tool_input` (+ `tool_response`); `Stop` has `stop_hook_active`,
  `last_assistant_message`.
- Output: `PreToolUse` → `hookSpecificOutput.permissionDecision` `allow`|`deny`
  (`ask` parsed but unsupported → hook failed, call proceeds);
  `PermissionRequest` → `hookSpecificOutput.decision.behavior` `allow`|`deny`,
  any deny wins; exit 2 blocks. Command hooks are synchronous; default timeout
  600 s (`SessionEnd`/`Interrupt` 1 s, max 3 s); `async` hooks cannot decide;
  errors/timeouts do not block. `approval_policy` `on-request`/`never`;
  `sandbox_mode` `workspace-write`/`danger-full-access` (CDX-C).

### 2.12 Gemini CLI (GEM)

- Hooks in `settings.json` (`~/.gemini/settings.json`, project `.gemini/`):
  `hooks.<Event>[] = { matcher?, sequential?, hooks: [{ type: "command", command,
  name, timeout (ms, default 60000), description }] }`; only `command` type.
- Events: `BeforeTool`, `AfterTool`, `BeforeAgent`, `AfterAgent`, `BeforeModel`,
  `AfterModel`, `BeforeToolSelection`, `SessionStart`, `SessionEnd`,
  `Notification`, `PreCompress`.
- Input base: `session_id`, `transcript_path`, `cwd`, `hook_event_name`,
  `timestamp`; `BeforeTool`/`AfterTool` add `tool_name`, `tool_input`.
- `BeforeTool` output: `decision` `allow`|`deny`, `reason` required on deny,
  `hookSpecificOutput.tool_input` merges into the arguments; exit 2 blocks.
  **No approval hook**: `Notification` (`notification_type: "ToolPermission"`,
  `message`, `details`) is observability only.

### 2.13 Prior art in reach

- Coucou (brief §2): Unix-socket relay binaries per tool; Gemini mapped
  `BeforeTool`→`PreToolUse`; Copilot fails closed with `permissionDecision: ask`;
  Codex limited to a status pill (written before Codex hooks existed).
- agenthropic `hooks/install.mjs` (read locally): default port 4317, token via
  env var + curl `--variable`/`--expand-header` (no secret in argv), delivery-id
  header, recognition of its own entries, non-destructive merge, timestamped
  backup, temp write + rename, `--remove`. `docs/analysis/parser-spec.md` §2
  specifies the transcript substrate (slug, record types, subagent sidecar join).

### 2.14 Local machine (read-only)

- `~/.claude/settings.json` has one hook (`UserPromptSubmit` → `node
  ~/.claude/hooks/usage-monitor.js`, timeout 10); no agenthropic hook installed.
  `claude` is not on `PATH` in the non-interactive shell, so the installed
  version could not be read.

## 3. Assumptions

- A1. The installed Claude Code is ≥ 2.1.295. Minimums the design relies on:
  2.1.257 (`--resume --bg` same ID), 2.1.248, 2.1.198 (`agent_*` notifications).
- A2. Raising `timeout` on `PermissionRequest` to 1800 s works as documented ("no
  maximum"); not exercised here. Ctrl+C at the terminal during a held hook was not
  verified (assumed: it cancels the turn, not just the hook).
- A3. While a `PermissionRequest` hook holds, the terminal shows no prompt (follows
  from "fires when about to show a prompt") — the local user cannot answer there.
- A4. `claude agents --json` works in a non-TTY script without opening agent view.
- A5. Unknown top-level keys in hook output JSON are tolerated (not tested).
- A6. Gemini `BeforeTool` `decision: "allow"` does not suppress Gemini's own
  confirmation dialog (verify before building an "allow from phone" path).
- A7. Codex has no `AskUserQuestion`-equivalent reachable through hooks; its
  session logs live under `~/.codex/sessions/` (community knowledge).
- A8. The agenthropic parser-spec still matches the current transcript layout
  (the owner's Phase-0 spike dated it; SE says the format may change per release).
- A9. Policy reading: running the user's own `claude` binary with the user's own
  login (as a terminal multiplexer would) is not "offering claude.ai login in an
  SDK-built product"; `-p`/SDK on the subscription inside our daemon is the grey
  zone (§8 Q4).

## 4. Findings

### 4.1 Brief §4 "hooks in `~/.claude/settings.json`" — CONFIRMED, with changes

- `PermissionRequest` as the blocking approval path is right: it fires exactly
  when a prompt would appear, carries `tool_input` and `permission_suggestions`,
  and can rewrite the input and persist rules (§2.2). While the hook runs
  nothing is shown in the terminal (A3); when it returns nothing or times out
  Claude's own prompt appears (and Remote Control relays it). Correct
  fail-safe: a timeout never grants anything.
- **Add** `PreToolUse` with matcher `^AskUserQuestion$`: the only documented way
  to answer a question from a hook is `allow` + `updatedInput.answers` (§2.3).
- **Add** `SubagentStop`, `SessionEnd`, `PreCompact`. Keep `Notification` as a
  **fallback** signal: `permission_prompt` fires ~6 s after a prompt was shown,
  i.e. only when our hook did not decide; `idle_prompt`, `agent_needs_input`,
  `agent_completed` drive push.
- **Reject** the `http` hook type: not allowed on `SessionStart`, needs
  `allowedHttpHookUrls` plus env-expanded headers (token in Claude Code's
  environment), and no place for our fail-open logic. A `command` hook running
  our script wins (§5.2).
- **Change**: hooks are inert in an interactive session until the folder is
  trusted (§2.1); installer and agent UI must surface this instead of silence.
- "Can a hook hold for minutes?" — **yes**: default 600 s, raisable, no maximum.
  The hook's `timeout` is the hard deadline of a pending request.

### 4.2 Brief §4 "Agent SDK or tmux/pty" — REJECT BOTH as the primary path

- The SDK can do (a) start in a directory, (b) follow-up via `streamInput` /
  `resume`, (c) surface permissions and questions via `canUseTool` — but
  products built on it must use an **API key** (§2.9): the user pays twice.
  Opt-in adapter for API-key users, not the default.
- tmux/pty has no contract: the session must already run inside tmux, keystroke
  injection races the user's typing, paste/submit behaviour follows the TUI.
- **Use Claude Code's own background sessions** (§2.8): `claude --bg` starts a
  full session (hooks, settings, subscription) under Anthropic's supervisor, no
  terminal, surviving our agent's restarts; `claude --resume <uuid> --bg` sends
  a follow-up (v2.1.257+); `claude agents --json` is the official registry of
  interactive *and* background sessions. Research preview — we use only the
  CLI surface, never the on-disk roster.
- A follow-up into a **foreground interactive** session has no official
  injection path (`-p --resume` from a TTY attaches only to background
  sessions, §2.7; two resumes interleave one transcript, §2.6). MVP item 3 is
  therefore "instruction to a background session (incl. those we started)";
  foreground sessions get "attach via Remote Control / terminal" on the phone.

### 4.3 Brief §5 Remote Control — CONFIRMED as overlap, cannot be built upon

No local API, Anthropic's relay, login-gated (§2.10). For a Pro/Max user driving
Claude Code only it already provides approvals, questions, live transcript,
follow-up and (`--spawn`) new sessions; not for API-key/gateway users, Codex or
Gemini. Our hooks coexist: our decision comes first; "hand to terminal" from the
phone (no decision) makes the prompt appear and Remote Control relays it.
Positioning is role #1's call.

### 4.4 Brief §7 Q8 Codex / Gemini — CHANGED (better than hypothesised)

Codex has first-class hooks including `PermissionRequest` in Claude Code's output
shape (§2.11) → full adapter, one UX cost: trust the hook in `/hooks` once.
Gemini has `BeforeTool` allow/deny and an observe-only `Notification`: watch and
deny from the phone, but its confirmation dialog cannot be answered (A6, §2.12).

### 4.5 Transcripts — CHANGE: hooks are the primary data source

The JSONL format is declared unstable (§2.6). `PostToolUse`, `Stop`,
`UserPromptSubmit` give MVP item 2 without parsing. The agenthropic parser is
reused only as optional backfill (history before the agent ran) behind a flag,
isolated so a format change degrades gracefully.

## 5. Recommendations

### 5.1 Hook set (installed into `~/.claude/settings.json`)

```json
{"hooks":{
  "PermissionRequest":[{"hooks":[{"type":"command","command":"node \"$HOME/.remote-control/hook.js\"","timeout":1800}]}],
  "PreToolUse":[{"matcher":"^AskUserQuestion$","hooks":[{"type":"command","command":"node \"$HOME/.remote-control/hook.js\"","timeout":1800}]}],
  "PostToolUse":[{"hooks":[{"type":"command","command":"node \"$HOME/.remote-control/hook.js\"","timeout":5}]}]}}
```
Same 5 s entry for `UserPromptSubmit`, `Notification`, `Stop`, `SubagentStop`,
`SessionStart`, `SessionEnd`, `PreCompact`; non-blocking events always exit 0
with no output. The two blocking ones hold up to 30 min (§8 Q1). Alternatives:
`async: true` feed hooks (lost: deferred delivery semantics we do not want, and
5 s sync is cheap); `http` hooks (lost, §4.1).

### 5.2 Hook command: own script with a per-install secret

`hook.js` (CommonJS, no deps, ~100 lines, copied to `~/.remote-control/` by the
installer, owned by `apps/agent`): reads stdin JSON and `~/.remote-control/
agent.json` (`{ port, token, generation }`, mode 0600, written by the agent on
start), POSTs to `http://127.0.0.1:<port>/hook` with `Authorization: Bearer
<token>`, waits up to the hook deadline minus 2 s, prints the agent's JSON
verbatim. Any failure (agent down, 401, timeout, bad JSON) → no output, exit 0.
The token is never in argv or settings; a local process without read access to
the 0600 file cannot post events. The receiver rejects requests with `Origin`.
Alternatives: curl `--variable` (agenthropic) — lost: needs curl ≥ 8.3 and the
agent already needs Node; compiled binary — lost: build/sign effort for no
gain; Unix socket (Coucou) — lost: no Windows parity, same local-only bound.

### 5.3 Session identity and registry

Key: `session_id` from the hook payload; project = `cwd` matched against the
allow-list; `transcript_path` kept for backfill. `SessionRegistry` is fed by
every event's `session_id` and enriched every 10 s (while any session is
known) from `claude agents --json --all` (`kind`, `name`, `state`, `status`,
`waitingFor`, `pid`). No event for 24 h and no roster entry → `stale`.
Alternative: the transcript directory (lost: unstable, no state, no names).

### 5.4 Starting and continuing sessions

- New session: `spawn("claude", ["--bg", "--name", name, prompt], { cwd })`,
  `cwd` allow-listed and Claude-trusted; UUID captured from `claude agents
  --json` by `name`+`cwd` or from the matching `SessionStart` hook. Optional
  `--permission-mode` from the phone, capped per repo in the agent config.
- Follow-up: `claude --resume <uuid> --bg "<text>"` for `kind: background`;
  `unsupported` for `kind: interactive`. Gate: `claude --version` ≥ 2.1.257 at
  agent start; older → follow-up disabled (never silently forked).
- Alternatives: long-lived `claude -p --input-format stream-json` child (works,
  hooks run, but dies with our daemon, invisible to agent view, policy grey
  zone — fallback if background sessions change); Agent SDK with API key
  (phase 3 adapter); tmux (not planned).

### 5.5 Live view

Feed events from hooks: `UserPromptSubmit.prompt`, `PostToolUse` (`tool_name`,
`tool_input`, truncated `tool_response`; unified diff for `Edit`/`Write`),
`Stop.last_assistant_message`, `SubagentStop`, `PreCompact`, `Notification`;
encrypted by the agent before leaving (interface from role #2). Backfill:
`TranscriptTailer` port, agenthropic parser as its only adapter, off by default.

### 5.6 Installer and coexistence

`remote-control hooks install|remove|status [--config-dir]`: merge our entries
(recognised by a command containing `/.remote-control/hook.js`) into
`~/.claude/settings.json`, never touch foreign entries (owner's
`usage-monitor.js`, agenthropic on port 4317), `settings.json.backup-<ts>`,
temp file + rename, `CLAUDE_CONFIG_DIR`. `remove` deletes only ours and drops
empty arrays. `status`: installed/outdated, Claude version, trust canary (did
any hook ever arrive from this cwd). Receiver default port 4327.

### 5.7 Adapter interface (ports & adapters, `apps/agent`)

```ts
export interface AgentAdapter {
  readonly id: 'claude-code' | 'codex' | 'gemini';
  detect(): Promise<{ installed: boolean; version?: string }>;
  installHooks(o: { configDir?: string }): Promise<void>;  // + removeHooks
  onHook(raw: unknown): HookEvent | null;              // vendor JSON -> common event
  decide(req: PendingRequest, d: Decision): unknown;   // common decision -> vendor JSON
  listSessions(): Promise<SessionInfo[]>;              // claude agents --json; others: registry only
  start(repo: string, prompt: string, o: StartOptions): Promise<{ sessionId: string }>;
  followUp(sessionId: string, text: string): Promise<'sent' | 'unsupported'>;
}
type HookEvent = { kind: 'permission' | 'question' | 'tool' | 'prompt' | 'stop' | 'session' | 'notice';
  sessionId: string; cwd: string; at: number; ttlMs?: number; payload: unknown };
type Decision = { behavior: 'allow' | 'deny' | 'handoff'; updatedInput?: unknown;
  answers?: Record<string, string>; message?: string; persistRule?: boolean };
```
`handoff` = return no decision (prompt appears in the terminal / Remote Control).

### 5.8 Home-agent architecture (smallest sound)

```
hook.js ─HTTP loopback─▶ HookReceiver (Fastify, 127.0.0.1:4327, bearer)
                             │ permission/question → PendingStore (id, deadline, resolver)
                             │ feed events        → SessionRegistry + EventFeed
                             ▼
                          RelayClient (outbound WSS, encrypt, ack/replay per role #3)
                             ▲ decision(id) → PendingStore.resolve → hook response
Launcher (claude --bg / --resume --bg, allow-list, trust check) ──▶ SessionRegistry
```
Pending request `{ id, sessionId, adapter, kind, deadlineAt, payload }`,
`deadlineAt = now + hookTimeout − 3 s`; at the deadline the resolver returns no
decision (handoff) and the phone gets `expired`. The receiver holds the HTTP
response open until resolution (one in-flight per `session_id`+`kind`; a
duplicate replaces and cancels). Needed from role #3: envelope with ids, acks,
late-decision semantics; from role #2: the encryption boundary (proposal: the
relay sees only a `sessionId` hash, `kind`, timestamps).

### 5.9 Codex and Gemini adapters (phase 2)

- Codex: write `~/.codex/hooks.json` with `PermissionRequest`, `PreToolUse`,
  `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`, `SessionEnd`
  pointing at the same `hook.js --adapter codex`; decisions
  `{"hookSpecificOutput":{"decision":{"behavior":"allow"}}}` /
  `{"hookSpecificOutput":{"permissionDecision":"deny"}}`; timeout 1800. The
  installer prints the `/hooks` trust instruction. Follow-up/new-session for
  Codex is unverified (§8).
- Gemini: `~/.gemini/settings.json` `hooks.BeforeTool` (`timeout: 1800000`)
  for a phone-side gate (allow passes to Gemini's own confirmation, deny blocks),
  `AfterTool`, `Notification`, `SessionStart`/`SessionEnd` for the feed.
  Honest label in the UI: "observe and deny only".

## 6. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| 1 | Background sessions (research preview) change CLI flags or semantics | medium | high — new session / follow-up break | pin minimum version, feature-detect via `claude agents --json`, keep the `-p stream-json` child as fallback adapter |
| 2 | Hook `timeout` silently capped or Ctrl+C semantics differ (A2) | low | medium | integration test on install: a fake `PermissionRequest` held 11 min against the real CLI; document the real ceiling |
| 3 | Interactive repo not trusted → no hooks, silent | high (first use) | medium | installer canary + agent UI hint; `status` command |
| 4 | Subscription-policy reading (A9) is wrong for `-p`/SDK fallbacks | low | high | primary path uses the user's CLI only; SDK adapter is API-key only |
| 5 | Transcript format change breaks backfill | high over time | low | parser isolated, flag off by default, errors logged not raised |
| 6 | Local malware posts fake events / decisions | low | high | 0600 token file, bearer check, loopback bind, decisions only accepted from the relay channel (never from `/hook`) |
| 7 | `PostToolUse` hook adds ~50–100 ms per tool call (Node start) | certain | low | 5 s budget, fire-and-forget POST, no retries; measure in W12 |
| 8 | Two decision paths race (phone vs Remote Control) | low | low | our hook decides first by construction; on `handoff` we never decide later (late decisions rejected by `PendingStore`) |
| 9 | Codex `/hooks` trust step skipped by users | medium | medium (no approvals) | installer doc + `status` check via a `SessionStart` canary |
| 10 | Gemini cannot answer its own dialog from the phone (A6) | high | low | advertise observe+deny only |
| 11 | Duplicate `PermissionRequest` for one tool call after resume/compact | low | low | dedupe by `session_id`+`tool_name`+hash(`tool_input`) within 2 s |

## 7. Work items

1. **W1 (S)** `hook.js`: stdin → POST loopback with bearer from 0600 file,
   deadline, fail-open. Deps: none. Accept: unit tests with a fake receiver
   cover agent-down, 401, timeout, success; exit code 0 and empty stdout in all
   failure cases.
2. **W2 (M)** `HookReceiver` + `PendingStore` in `apps/agent` (Fastify,
   loopback, constant-time token compare, one in-flight per session+kind,
   deadline = hook timeout − 3 s). Deps: W1. Accept: `node --test` holds a
   request 5 s then resolves with `allow`; expired request returns `{}`.
3. **W3 (S)** Hook installer `install|remove|status` with backup, merge,
   recognition by command path, `CLAUDE_CONFIG_DIR`. Deps: W1. Accept: fixture
   settings with foreign hooks round-trips byte-identical except our entries;
   `remove` after `install` restores the fixture.
4. **W4 (S)** Claude adapter `onHook`/`decide` for `PermissionRequest` and
   `PreToolUse:AskUserQuestion` (answers → `updatedInput`). Deps: W2. Accept:
   golden tests using the §2 JSON examples produce the documented outputs.
5. **W5 (M)** Real-CLI integration test (not CI): `claude --bg` in a temp
   trusted repo forcing a Bash permission; hook held ≥ 11 min and decided from
   a test client; verifies A2/A3. Deps: W2–W4. Accept: log under
   `docs/verification/` with Claude version, timings and outcome.
6. **W6 (S)** `SessionRegistry` fed by hooks + `claude agents --json` poll.
   Deps: W2. Accept: unit test merges a hook-only session and a roster entry
   into one record; stale marking after TTL.
7. **W7 (M)** `Launcher`: allow-list, trust canary, `claude --bg --name`,
   UUID capture, `--resume <uuid> --bg` follow-up, version gate ≥ 2.1.257.
   Deps: W6. Accept: tests with a fake `claude` on `PATH` assert exact argv and
   cwd; a path outside the allow-list is refused before spawn.
8. **W8 (M)** Feed mapping: `UserPromptSubmit`, `PostToolUse` (+ diff for
   Edit/Write), `Stop`, `SubagentStop`, `PreCompact`, `Notification` →
   `HookEvent`, size-capped. Deps: W4. Accept: golden tests; payload ≤ 64 KB.
9. **W9 (L)** `RelayClient` against role #3's envelope + role #2's encryption
   boundary: outbound WSS, reconnect, resend of pending requests with remaining
   TTL, decision intake. Deps: W2, W8, reports 02/03. Accept: fake relay test —
   pending request survives a reconnect and a late decision is rejected.
10. **W10 (S)** `--permission-mode` bound per repo + `permission_suggestions`
    → "always allow" from the phone (`updatedPermissions`). Deps: W4, W7.
    Accept: test shows rule persisted to `localSettings` only when requested.
11. **W11 (M)** `TranscriptTailer` port + agenthropic parser adapter behind a
    flag. Deps: W6. Accept: parses the agenthropic fixtures; a malformed line
    never throws out of the port.
12. **W12 (S)** Latency/overhead measurement of W1 on a 200-tool-call run,
    documented. Deps: W5. Accept: p95 hook overhead < 150 ms recorded.
13. **W13 (M)** Codex adapter (`hooks.json` writer, `PermissionRequest`/
    `PreToolUse` mapping, trust instruction, canary). Deps: W4. Accept: golden
    tests on §2.11 shapes; manual run log as in W5.
14. **W14 (M)** Gemini adapter (`BeforeTool` gate, `Notification`, feed).
    Deps: W4. Accept: golden tests; manual log records whether A6 holds.
15. **W15 (L, optional)** `claude-sdk` adapter with API key (`canUseTool`,
    `streamInput`, `resume`). Deps: W9. Accept: same approval/question flow
    passes the W5 scenario through the SDK.

## 8. Open questions for the owner

1. Hold time for a pending approval: default **30 min** hook timeout (then
   handoff to the terminal). Longer is possible but a forgotten phone keeps a
   session frozen.
2. On agent-side expiry, **handoff** (terminal prompt appears) rather than
   **deny** — default handoff; deny is safer only if the machine is unattended.
3. Follow-up for foreground interactive sessions: accept "unsupported" in MVP
   (default) vs a tmux adapter later.
4. Is a `-p`/SDK child on the user's subscription acceptable to you as a
   fallback (A9)? Default: no — background sessions only, SDK = API key.
5. Allow "always allow" rule persistence from the phone (`updatedPermissions`)
   in MVP? Default: no (allow/deny only), add in W10 after security review.
6. Ship Codex before Gemini? Default: yes — Codex has real approvals, Gemini
   is observe/deny only.
7. Default receiver port 4327 and config dir `~/.remote-control/`? Default: yes
   (does not collide with agenthropic 4317).

## 9. Sources

- H — https://code.claude.com/docs/en/hooks
- HG — https://code.claude.com/docs/en/hooks-guide
- HL — https://code.claude.com/docs/en/headless
- SE — https://code.claude.com/docs/en/sessions
- AV — https://code.claude.com/docs/en/agent-view
- RC — https://code.claude.com/docs/en/remote-control
- ST — https://code.claude.com/docs/en/settings
- SDK-O — https://code.claude.com/docs/en/agent-sdk/overview
- SDK-TS — https://code.claude.com/docs/en/agent-sdk/typescript
- SDK-UI — https://code.claude.com/docs/en/agent-sdk/user-input
- SDK-P — https://code.claude.com/docs/en/agent-sdk/permissions
- SDK-S — https://code.claude.com/docs/en/agent-sdk/sessions
- CDX-H — https://developers.openai.com/codex/hooks (redirects to
  https://learn.chatgpt.com/docs/hooks)
- CDX-C — https://learn.chatgpt.com/docs/config-file/config-basic
- GEM — https://geminicli.com/docs/hooks/reference/
- Coucou — https://github.com/Louis-CFM/coucou (README, `docs/IPHONE.md`)
- agenthropic (local) — `/Users/ivanbaev/Development/agenthropic/hooks/install.mjs`,
  `/Users/ivanbaev/Development/agenthropic/docs/analysis/parser-spec.md`
