# v3.0 analysis 04 — Agent and ecosystem integration

Status: 2026-10-28. Role: agent and ecosystem integration engineer. Inputs: `00-brief.md`,
v1 `ROADMAP.md` §1, §2 (D7, D11–D14, D25), ADR 0008/0010/0013/0014/0015, the v2 corpus
(`v2/SYNTHESIS.md`, `v2/ROADMAP-v2.md`, `v2/reports/04-agent-integration.md`, cited
below as "v2-04 §x"), and the current adapter code (`apps/agent/src/ports/agent-adapter.ts`,
`apps/agent/src/adapters/*`).

## 1. Summary

- The leverage for 3.0 is **one new peer role, the requester**, not more adapters. A
  requester is a paired, ask-only identity (CLI, MCP server or hook script). It seals an
  approval request end to end to the phone and **verifies the signed decision itself**,
  using the ADR 0010 check. I1 and I3 hold unchanged, and no I1 amendment is needed.
- The same requester binary gives three things almost for free: (a) CI and deploy gates
  (`npx remotectl approve`, exit code); (b) a human-in-the-loop tool for any MCP client
  or workflow; (c) reach into cloud agents whose **repo-committed hooks** can call out
  (Claude Code cloud sessions, Copilot cloud agent, Cursor cloud agents).
- Cloud verdict: **no dedicated cloud adapters and no vendor cloud API calls in 3.0**.
  Claude cloud gets a documented hook recipe after a spike. Copilot and Cursor cloud stay
  experimental recipes. Codex cloud is unreachable, so we show nothing for it.
- Driving: dispatch by phone only, as the existing sealed `start` command. The one new
  literal argv target is `claude --cloud`, and it stays inside D13. Voice input is
  on-device dictation into the existing text field. No orchestration engine.
- Adapters: Copilot CLI is the one new adapter worth a spike, because its hook surface
  matches Claude Code's. OpenCode is second, through its HTTP permission API. Refuse
  Aider and Amp. Keep Antigravity frozen. Cursor CLI waits on verification.

## 2. Verified facts

### Claude Code: cloud sessions (Claude Code on the web)
- `claude --cloud "<task>"` starts a cloud session; `--remote` is a deprecated alias.
  `claude -p "msg" --cloud <session-id>` queues a follow-up from any logged-in machine.
  `--output-format json` returns `{ok, session_id, url}`. `--teleport` pulls a session
  into the terminal. All of these need a claude.ai login, not an API key, Bedrock or
  Vertex. They also need the org policy that allows remote sessions. ZDR, HIPAA and CMEK
  orgs cannot use cloud sessions. The permission mode is chosen in the web UI. Claude in
  Slack shows Allow/Deny cards. https://code.claude.com/docs/en/claude-code-on-the-web
- A single-repo cloud session reads the repo's `.claude/settings.json`, including hooks
  and permissions. Project threads and multi-repo sessions do not read repo hooks. User
  and local settings are not read. Only server-managed settings reach cloud sessions.
  https://code.claude.com/docs/en/settings#settings-in-cloud-sessions
- Cloud environments have four network levels: None, Trusted (the default allowlist),
  Custom (your own domains) and Full. Environment variables are readable by anyone who
  uses the environment. Network secrets are attached by a proxy outside the VM, only for
  the listed hosts. Repo `.mcp.json` servers load in single-repo sessions. Self-hosted
  environments also run the runner host's `~/.claude` hooks. MCP connector traffic is
  routed through Anthropic. https://code.claude.com/docs/en/cloud-environments
- Hooks: `Elicitation` fires when an MCP server asks for user input during a tool call.
  `ElicitationResult` fires before the response goes back to the server. Both match on
  the MCP server name. Both accept `action` (accept, decline or cancel) and `content`
  (form values) through `hookSpecificOutput`, which is applied only on exit 0; exit 2
  declines. Notification types include `elicitation_dialog`, `elicitation_url_dialog`,
  `agent_needs_input` and `agent_completed`. https://code.claude.com/docs/en/hooks

### Claude Code changelog, 2026-10-20 to 2026-10-28 (https://code.claude.com/docs/en/changelog)
- 2.1.312 (Oct 27): concurrent prompt and agent hooks are capped at 24 per session
  (plus 12 overdue). A hook timeout under 1 s is treated as 1 s. A Remote Control idle
  fix.
- 2.1.311 (Oct 26): fixed SubagentStop firing about twice a minute. Added
  `claude daemon stop --any`. Fixed `claude respawn <id>`. Self-hosted runners gained
  `--hold-idle-file` and `--max-hold-min`. Fixed Remote Control messages showing on
  mobile as the user's own.
- 2.1.310 (Oct 23): in non-interactive sessions, an MCP elicitation timeout now tells
  Claude that no answer came, so it does not retry in a loop. Enterprise custom roles
  gained permissions for Cloud sessions and Remote Control.
- 2.1.309 (Oct 22): `claude ultrareview` requires workspace trust. Dangerous `rm` is
  denied even in bypass mode. PowerShell PreToolUse and PermissionRequest hooks no longer
  fail open. Fixed Allow/Deny in Claude in Slack.

### MCP elicitation (spec 2025-11-25)
- The server sends `elicitation/create` with `mode` `form` or `url`. Form schemas are
  flat objects of primitives (string, number, boolean, enum). Responses are `accept`
  (with content), `decline` or `cancel`. Servers MUST NOT use form mode for secrets. URL
  mode is the path for sensitive interactions and is marked as new and subject to change.
  Clients MUST show which server is asking, MUST NOT open a URL without consent, and MUST
  show the full URL. Elicitation is a client capability, and servers MUST NOT send a mode
  the client did not declare.
  https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation

### Other agents
- Cursor hooks: `beforeShellExecution` and `beforeMCPExecution` return allow, deny or ask.
  `preToolUse` returns allow or deny; `ask` is in its schema but not enforced. Cloud
  agents run only command hooks, including `beforeShellExecution` and `preToolUse` but
  not `beforeMCPExecution` or session events. Hooks do not run on read-only exploratory
  turns. Config lives in `.cursor/hooks.json` (project), `~/.cursor/hooks.json` (user),
  team and MDM. The page does not say which agent hooks run in Cursor CLI.
  https://cursor.com/docs/agent/hooks
- Cursor Automations run cloud agents on a schedule or on events, including an inbound
  webhook with an API key. https://cursor.com/docs/cloud-agent/automations
- GitHub Copilot hooks: config is `.github/hooks/*.json`. The cloud agent uses it only
  from the default branch. `preToolUse` returns `permissionDecision` allow, deny or ask,
  plus `modifiedArgs`. In the cloud agent and CLI autopilot, `ask` means deny. The default
  timeout is 30 s, and **a timeout is fail-open**; a crash or non-zero exit is
  fail-closed. Copilot CLI supports every event, including `permissionRequest` and
  `notification`; in the cloud agent those two have no effect.
  https://docs.github.com/en/copilot/reference/hooks-configuration ·
  https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/use-hooks
- OpenCode: permissions are allow, ask or deny per tool and pattern; `--auto` approves
  every ask, but deny rules still apply. Its server exposes
  `POST /session/:id/permissions/:permissionID` with body `{response, remember?}`, an
  SSE stream at `GET /event`, and optional basic auth through `OPENCODE_SERVER_PASSWORD`.
  https://opencode.ai/docs/permissions/ · https://opencode.ai/docs/server/
- Codex cloud runs in OpenAI-managed containers with agent internet access off by
  default. Limited or full access is configured per environment.
  https://developers.openai.com/codex/cloud

## 3. Assumptions (not verified; each has a spike or a default)

- A1. A repo `PermissionRequest` or `PreToolUse` command hook in a Claude cloud session
  fires under the mode chosen in the web UI. It can reach our relay over HTTPS/WSS when
  the environment is Custom (relay domain allowed) or Full. It gets the same
  hook-timeout semantics as local hooks. (Spike V3-A01.)
- A2. The agent inside a cloud VM can read and rewrite files the hook depends on (the
  repo, `node_modules`) and read env vars. Claude Code snapshots hook *config* at session
  start, but not the hook *script's* bytes.
- A3. The MCP tool-call timeout in Claude Code is long enough (minutes) for a phone round
  trip. If not, `request_human_approval` must return `pending` and be polled.
- A4. Passkey signature counters on iOS are often 0. An ephemeral requester such as a CI
  runner cannot persist a counter anyway, so replay protection for requesters rests on a
  fresh requester nonce, the request id and the 300 s TTL in the signed canonical
  decision (ADR 0010), not on the counter.
- A5. The Copilot cloud agent's network firewall must allowlist the relay domain. Its
  `timeoutSec` can be raised well above 30 s. Neither is verified.
- A6. Cursor CLI honours `beforeShellExecution` from `.cursor/hooks.json`. The hooks page
  does not say so.
- A7. Amp's `amp.permissions` "delegate" action may no longer be in the published
  settings schema. Third-party issues say plugins replace it
  (https://github.com/littlebearapps/untether/issues/174). Treat it as unstable.
- A8. Aider has no pre-execution hook or approval API, only interactive confirm prompts.
- A9. Codex cloud exposes no pre-tool hook or approval callback to third parties. Its
  tasks run to completion and produce a diff or PR.
- A10. iOS `SFSpeechRecognizer` with `requiresOnDeviceRecognition = true` is good enough
  for short English instructions on the devices we target.

## 4. Findings

### 4.1 Cloud and background agents the daemon does not host

v2-04 §4.2 concluded that cloud tasks are unreachable, and R7/R10 kept them read-only.
New facts change that only for agents that run **repo-committed command hooks** in the
VM and allow outbound network:

| Agent (cloud) | Pre-execution surface | Reach without breaking I1–I4 | Vendor approval UI exists |
|---|---|---|---|
| Claude Code cloud session | Repo `.claude/settings.json` hooks; repo `.mcp.json` | Yes, via a requester hook if the network is Custom or Full (A1) | Yes: web, Claude app, Slack cards |
| Copilot cloud agent | `.github/hooks` `preToolUse` allow/deny | Yes, if the firewall allows it (A5); timeout is fail-open | Not for tool calls (CLI-only `permissionRequest`) |
| Cursor cloud agent | `beforeShellExecution`, `preToolUse` command hooks | Yes, if network egress allows it | Unknown |
| Codex cloud | None found (A9) | No | n/a |
| `claude --bg` (local) | Already covered by D11 | Yes, v1 | Yes, if Remote Control |

What the "reach" column means for the invariants:
- **I1.** It holds by construction. The hook process is the requester, and it acts only
  on a phone assertion it verified itself. The relay can only drop requests.
- **I3.** It holds. The request is sealed to the phone.
- **I2.** It needs a per-vendor deadline. Copilot's timeout is fail-open, so our hook must
  return an explicit deny before `timeoutSec`.
- **Gap: enforcement integrity, not authority.** On a home machine, Claude's own
  permission flow guards edits to `hook.js` (D11). In a cloud VM the agent shares a
  filesystem with the gate (A2). In auto-accept modes it could neuter the hook script
  for later calls. Treat cloud reach as **"verified decision, sandbox-dependent
  enforcement"**: label it on the card and in docs, and never sell it as equal to local.
  Self-hosted runners with host `~/.claude` hooks close most of the gap.

**Value check against the v2 niche** ("agents the vendor's phone app does not cover",
`v2/SYNTHESIS.md`). Claude cloud sessions are already covered by the Claude app and
Slack cards, and cloud users must have claude.ai logins. Our added value there is only
"one inbox" plus the passkey signature. So Claude cloud reach is worth doing **only
because it is nearly free** once the requester exists. Copilot cloud agent tool calls
have no vendor approval surface, which makes it the most interesting gap. It is also the
least verified one, with the fail-open timeout and firewall (A5).

Not pursued: vendor cloud APIs and webhooks. Cursor status webhooks, the Automations
API, the Claude `/fire` routine API (v2-04 F4, R7) and Codex cloud would all need the
relay or a hosted service to hold vendor tokens and receive plaintext task data. That
violates I3, and arguably I1, because the relay could trigger work. A home-daemon
alternative (polling vendor APIs with the user's token) adds token custody and
maintenance for read-only cards the vendor app already shows.

### 4.2 A generic approval primitive

**Three candidate shapes:**
1. *MCP elicitation as the transport.* This is the wrong direction for our server.
   Elicitation is server→client→user, so it asks the user sitting at the MCP *client*.
   It is useful the other way round: a Claude Code `Elicitation` hook forwards
   elicitations from headless or `--bg` sessions to the phone. 2.1.310 makes the
   unanswered case clean.
2. *MCP tool `request_human_approval`.* Any MCP client (Claude Code, Codex, Cursor,
   Copilot, LangGraph/Agent SDK MCP clients, n8n MCP nodes) can call it. Caveat: the LLM
   decides whether to call it, and it can ignore a deny. It is a **check-in, not a
   control**. It must be documented that way and must never replace hooks.
3. *CLI and exit code (`remotectl approve`).* The caller enforces the result. In CI and
   deploy pipelines the step fails on deny. In workflows (n8n Execute Command, a
   LangGraph node, an Agent SDK `canUseTool`) the caller branches on JSON. **This is the
   only shape that is a real gate outside our own hooks.** It is also the base of the
   cloud hook recipes in 4.1, because a hook is just a CLI invocation with a
   vendor-shaped stdin and stdout.

**Protocol (additive under D14).**
- New peer role `requester`, paired like a computer through Noise XXpsk0 and msg3.
  The requester receives the phone passkey SPKIs, as in ADR 0010.
- At pairing the phone records a human label (`ci-prod-deploy`) and a scope. v1 scope is
  exactly one thing: it may send `request{type:"approval"}` and receive replies. The
  phone never sends `start`, `instruct` or `always` to a requester. Requester-originated
  requests offer only Allow and Deny (`answer` for the `ask_human` variant).
- Request payload (sealed): `{title, detail (≤ 8 KiB text), detailDigest?,
  requesterNonce, deadline}`. The canonical decision hash binds the request id, nonce
  and digest. The requester verifies ES256, rpIdHash, UV, TTL and nonce; the counter is
  skipped when ephemeral (A4).
- The relay sees only role, size and timing metadata. It cannot tell a CI gate from a
  Claude hook, and no relay change is needed beyond accepting the new peer role (I3).
- D25 fan-out and first-wins apply unchanged.

**Adapter shape.** This is not an `AgentAdapter`. It is a separate small entry point
inside the same npm package, so I4 holds: one `npx`, no new install path.
- `remotectl pair --role requester --label <l>`
- `remotectl approve [--hook claude|copilot|cursor] [--timeout s] [--json]`
- `remotectl mcp` (stdio, tools `request_human_approval` and `ask_human`)

These share `packages/protocol` and a verifier extracted from the agent (V3-A03). The
`--hook` translators are about 30 lines each: they map vendor stdin to a request and a
decision to the vendor's stdout. On the home machine, the daemon's own adapters stay the
preferred path.

**Key custody.** In CI or a cloud VM, the requester's Noise static key lives in a
secret or env var. Anyone who can read the env can **ask**, but cannot **decide**.
- The residual threat is approval phishing: a stolen key sends plausible-looking
  requests.
- Mitigations: the label is fixed by the phone at pairing and shown on every card; a
  per-requester rate limit is enforced on the phone side (default 10 per hour, excess
  auto-denied unseen); one-tap revoke.
- In branch B, revoke uses the local revocation from v2 (`v2/SYNTHESIS.md` line 42).

**Why this is not the I1 amendment v2 deferred.** Nothing is auto-allowed, and every
allow is a fresh UV assertion. The requester is simply a second verifier, alongside the
agent.

### 4.3 Driving the fleet from the phone (inside D13)

- **Dispatch.** Keep the existing sealed `start` command (D11, ADR 0015 for the SDK). Add
  one new spawn target: literal argv `claude --cloud <prompt-as-single-arg>`, plus the
  follow-up form `claude -p <msg> --cloud <id>`. Neither form contains a forbidden D13
  token, and the prompt is a single argv element, never a shell string. This applies only
  when the home machine has a claude.ai login (detected, capability flag). Its value is
  starting long jobs that should not keep the Mac awake.
- **Orchestration.** v2-04 R2 already rejects building a supervisor ("agent view already
  is one"). For 3.0, the phone shows the fleet (v2 FeedPort in branch A, or the v1
  session list in branch B) and sends `start`, `instruct` and `stop`. No multi-step
  plans, DAGs or "run X then Y" in the phone or relay. That belongs to the agent, such as
  Claude's own subagents and agent teams, or to the user's workflow tool, which can call
  the requester.
- **Voice.** On-device dictation only (A10), producing the text that goes into the
  existing `instruct` or `start` field. The user reviews it before the signed send.
  - No server-side transcription. It would break I3, and the "Never" list in ROADMAP §1
    rules out a variant that uses the computer's API keys ("chat through the computer's
    API keys").
  - No voice-to-decision path ("say allow"), because D7 needs a UV assertion.
- **Handoff.** `--teleport` (cloud to terminal) exists on the vendor side. A phone
  "teleport" button would need a new argv shape and a TTY; leave it out of 3.0.

### 4.4 New agents: adapter or refuse

| Agent | Surface (verified or assumed) | Verdict |
|---|---|---|
| Copilot CLI | `preToolUse` allow/deny/ask, `permissionRequest`, repo and user hooks (verified) | **Spike, then full adapter** (Codex-like). Closest to the D11 shape |
| OpenCode | HTTP permission reply API, SSE events, basic auth (verified) | **Second**, as an ADR 0015-style non-hook transport after demand |
| Cursor CLI | Hooks verified for the IDE and cloud; CLI unclear (A6) | **Spike only**. Adapter if A6 holds |
| Amp | `delegate` unstable or removed (A7); plugin API instead | **Refuse** in 3.0. Re-check at the next competitive watch |
| Aider | No hook or approval surface (A8) | **Refuse** |
| Antigravity, Gemini allow | v2 froze them (`v2/SYNTHESIS.md`) | **Stay frozen**. Gemini remains deny-only (ADR 0013) |
| ACP-generic | Not analysed beyond v2-04 §4.5 point 5 | Out of 3.0 |

The generic requester also covers any agent with a pre-tool command hook (`--hook`
translators). So "adapter" in 3.0 means a native, daemon-hosted integration with session
listing and start. The requester is the long tail.

### 4.5 Branch A versus branch B

- **Branch A (v2 shipped as drafted).**
  - A requester is a principal with role `requester` in the signed policy bundle (v2
    teams-lite). Quorum and k-of-n apply to its requests, which gives two-person deploy
    approval for free. The hash-chained audit records them.
  - The `--hook` translators live behind v2's `ApprovalPort` (v2-04 R1) when the daemon
    hosts them.
  - Dispatch uses `SessionPort.start` with `target:"cloud"`.
- **Branch B (v2 collapsed into 1.x, no teams).**
  - A requester is a peer of the single owner, with no principals, roles or quorum.
  - Revocation is local (`remotectl peers revoke`) plus phone-side delete.
  - Dispatch is a new literal in today's `spawn.ts`.
  - Nothing in V3-A01…A10 depends on the v2 port split. The requester reuses only
    `packages/protocol` and the extracted verifier. All work items are therefore valid in
    both branches; A-only extras are marked.
- In both branches the requester is the strongest 3.0 differentiator from this lens. It
  turns "approve my agents" into "a phone-verified human decision any automation can
  require". Vendor phone apps do not offer that, because they are not cross-vendor and
  have no CI gate.

### 4.6 Claude Code changes since 2026-10-24 that matter

1. **2.1.312 hook concurrency cap** (24 prompt and agent hooks). Our hooks are command
   hooks, so we are probably unaffected. Add a fixture that 30 parallel subagent tool
   calls all reach the phone or time out cleanly (I2).
2. **2.1.312 sub-1-second timeouts become 1 s.** This has no impact unless a test
   configures a sub-second timeout. Check the hook-timeout fixtures.
3. **2.1.311 SubagentStop storm fixed.** Drop any feed-side debounce added for it, and
   pin the minimum CLI version in capability negotiation (v2-04 §4.5).
4. **2.1.311 `claude daemon stop --any` and the `respawn` fix.** These are candidates for
   the v2 `stop` and `respawn` session commands (v2-04 R2) as literal argv.
5. **2.1.310 Enterprise custom roles for Cloud sessions and Remote Control.** Orgs can
   now switch off Remote Control per role. That widens our "users who cannot use Remote
   Control" segment (ROADMAP §1 reason b). It is a product signal, not code.
6. **2.1.310 elicitation timeout semantics** make the V3-A06 Elicitation forwarder safe:
   on our deadline we return `cancel`, and Claude stops retrying.

## 5. Recommendations (with rejected alternatives)

R1. **Build the requester role (ADR plus CLI) as the 3.0 agent-integration headline.**
- Rejected: an HTTP approval API hosted on the relay. The relay would hold request
  plaintext and act as an authority, breaking I1 and I3.
- Rejected: webhooks from the relay to callers (same problem, plus a callback secret
  store).
- Rejected: routing requester requests through the home daemon. That needs the Mac to be
  up for CI to deploy, and it doubles the trust path.

R2. **CLI first (`remotectl approve`), MCP second (`remotectl mcp`), both labelled
honestly.** The CLI is the enforcing gate. The MCP tool is a check-in.
- Rejected: MCP-only. An LLM can ignore its result.
- Rejected: MCP elicitation as transport (wrong direction, 4.2).

R3. **Forward Claude Code `Elicitation` (form mode) from headless and `--bg` sessions to
the phone as `answer`; decline URL mode.**
- Rejected: opening elicitation URLs on the phone. That is a phishing vector, and the
  spec demands that the full URL be shown and a browser context used. It adds UI for
  little value.

R4. **Cloud reach only through repo-committed requester hooks, Claude first, after
spike V3-A01. Cards carry a "sandbox-enforced" label.**
- Rejected: dedicated cloud adapters.
- Rejected: vendor cloud APIs and webhooks (I1, I3, token custody, 4.1).
- Rejected: Codex cloud integration (no surface).

R5. **Dispatch adds only `claude --cloud` as a literal argv target. Voice is on-device
dictation into existing fields.**
- Rejected: a phone orchestration engine (v2-04 R2 reasoning).
- Rejected: server or LLM transcription (I3, ROADMAP §1 "Never").
- Rejected: voice decisions (D7).
- Rejected: a phone teleport.

R6. **At most one new native adapter in 3.0: Copilot CLI, after a spike. OpenCode is
next on demand. Refuse Aider and Amp; keep Antigravity frozen.**
- Rejected: Cursor CLI before A6 is verified.
- Rejected: "an adapter per popular agent" (maintenance load for one developer; the
  requester covers the long tail).

**What 3.0 should NOT contain (agent-integration lens):**
- Any relay endpoint that accepts vendor webhooks or holds vendor tokens.
- A hosted cloud runner of our own.
- Auto-allow for requesters.
- URL-mode elicitation.
- Server-side voice.
- A plan or DAG orchestrator.
- Amp, Aider or Antigravity adapters.
- An ACP-generic transport.
- Codex cloud cards.
- Calls to `/fire` or Cursor Automations from anywhere but the user's own tooling.

## 6. Risks

| Id | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| K1 | Cloud agent neuters the hook script mid-session (A2) | M / H | "Sandbox-enforced" label; recipe installs the hook from a pinned npx version in the env setup script, outside the repo tree; recommend self-hosted runner hooks for strict users |
| K2 | Requester key leak leads to approval phishing | M / M | Phone-fixed label, per-requester rate limit, one-tap revoke, distinct card colour for requester requests |
| K3 | Copilot `preToolUse` timeout is fail-open | H / H | Hook sets `timeoutSec` = our deadline + 15 s, and the requester returns deny at our deadline; AC tests it |
| K4 | Teams read the MCP tool as a security control | M / M | Tool description and docs say "advisory"; README matrix "enforced by: hook / CI / advisory" |
| K5 | Vendor hook schemas drift (Copilot, Cursor, Claude) | H / L | Translators are tiny, version-tagged and tested with recorded fixtures; unknown shape means deny with reason |
| K6 | Anthropic or GitHub ship cross-vendor or CI approval | L / H | Watch item for the v3 kill criterion (competitive watch, K1–K5 in v2) |
| K7 | Scope creep from "driving" into orchestration | M / M | R5 and the not-in-3.0 list; work item A09 is argv-only |

## 7. Work items

All items are valid in branches A and B unless marked. "Gate" means `pnpm check` green
and `node apps/agent/scripts/check-argv-policy.mjs` exit 0.

| Id | Size | Deps | Work | Machine-checkable AC |
|---|---|---|---|---|
| V3-A01 | S | — | Spike: Claude cloud session with a repo `PreToolUse` and `PermissionRequest` hook calling a stub endpoint on the relay domain (Custom network) | `docs/spikes/v3-a01-cloud-hook.md` exists with a table of 6 rows (hook fires y/n per mode; egress ok; timeout honoured; env readable; script mutable by agent; `.mcp.json` server loads), each `pass`/`fail` with a session id |
| V3-A02 | M | — | ADR `docs/adr/NNNN-requester-peer.md`: role, scope, pairing label, canonical-decision binding with nonce, counter rule (A4), rate limit, revocation, branch A/B notes | ADR file exists with `Status: Proposed`; protocol zod tests: a requester `request{type:"approval"}` parses, and `command{start}` addressed to a requester is rejected by the phone handler (unit test) |
| V3-A03 | M | A02 | Extract the assertion verifier into `packages/decision-verify` (zero runtime deps); the agent consumes it | `pnpm -F agent test` green; `packages/decision-verify/package.json` has no `dependencies`; the verify test vectors from ADR 0010 pass in the new package |
| V3-A04 | M | A02, A03 | `remotectl pair --role requester` and `remotectl approve` (exit 0 allow, 1 deny, 2 timeout, 3 error; `--json`) | E2E test with staging relay and fake phone: four exit codes observed; relay log grep for the request title returns 0 lines (privacy gate); a forged assertion gives exit 1 |
| V3-A05 | S | A04 | `--hook claude` and `--hook copilot` translators (stdin to request, decision to vendor stdout); deny on our deadline | Fixture tests: allow, deny and timeout produce exact vendor JSON; for copilot, timeout produces `permissionDecision:"deny"` with reason, never empty output |
| V3-A06 | S | — | Claude Code `Elicitation` hook forwarding: form mode to phone `answer`, URL mode to decline | Unit fixtures: URL mode yields `action:"decline"`; a form with a non-primitive schema yields decline; a timeout yields `cancel` before the hook timeout |
| V3-A07 | S | A01 pass, A05 | Documented cloud recipe (`docs/recipes/claude-cloud.md`) and `remotectl init-hook --cloud` writing the repo hook snippet | Generated `.claude/settings.json` validates against the Claude Code settings schema; the snippet contains a pinned version, no `@latest` (I4 test greps) |
| V3-A08 | M | A04 | `remotectl mcp` stdio server: `request_human_approval`, `ask_human` (flat schema) | MCP inspector `tools/list` shows both; the tool returns `denied`/`timeout` within the configured deadline; the tool description contains the word "advisory" |
| V3-A09 | S | — | Spawn target `claude --cloud <prompt>` and `claude -p <msg> --cloud <id>`, behind a `cloudDispatch` capability (claude.ai login detected) | argv-policy gate passes with the new literals; unit test: the prompt is exactly one argv element; capability false when login is absent (mocked `claude auth status`) |
| V3-A10 | S | — | Phone: mic button with on-device dictation into the instruct and start fields | `grep -r "requiresOnDeviceRecognition = true"` matches in the app; no network call in the speech module (lint rule or test); the send still requires a UV assertion (existing test) |
| V3-A11 | S | — | Spike: Copilot CLI adapter feasibility (`permissionRequest` allow/deny, timeout, user-level hooks) and Cursor CLI A6 | `docs/spikes/v3-a11-copilot-cursor.md` with a go/no-go per agent and recorded hook stdin fixtures committed under `apps/agent/test/fixtures/` |
| V3-A12 | M | A11 go | Copilot CLI native adapter (approve/deny, observe sessions) | Adapter contract tests pass with A11 fixtures; `AgentAdapterId` includes `copilot-cli`; the I2 timeout fixture passes |
| V3-A13 | S | A02 (branch A only) | Requester as a principal in the signed policy bundle; quorum on requester requests | Policy test: a 2-of-2 requester request stays pending after one allow and resolves after two |

Order: A02, A03, A04 → A05, A08 → A01 → A07. A06, A09, A10 and A11 are independent.
The cut line for a lean 3.0 is A01–A08.

## 8. Open questions for the owner (defaults apply until answered)

| Id | Question | Default |
|---|---|---|
| Q1 | Is the requester role (CI and deploy gate, MCP check-in, hook recipes) the 3.0 headline for agent integration? | Yes, with the CLI shipped first and MCP second |
| Q2 | Accept cloud reach whose enforcement depends on the vendor sandbox (K1)? | Yes, for Claude cloud only, opt-in, card labelled "sandbox-enforced"; Copilot and Cursor stay experimental docs |
| Q3 | Accept requester keys in CI and cloud env vars (ask-only, approval-phishing risk)? | Yes, with a phone-fixed label, 10 requests per hour per requester, and one-tap revoke |
| Q4 | One new native adapter in 3.0? | Copilot CLI if the A11 spike passes; otherwise none |
| Q5 | Dispatch to `claude --cloud` from the phone? | Yes, after A01, gated on a detected claude.ai login |
| Q6 | Voice input? | On-device dictation only, English first |

## 9. Sources

- https://code.claude.com/docs/en/claude-code-on-the-web
- https://code.claude.com/docs/en/settings#settings-in-cloud-sessions
- https://code.claude.com/docs/en/cloud-environments
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/changelog
- https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
- https://cursor.com/docs/agent/hooks
- https://cursor.com/docs/cloud-agent/automations
- https://docs.github.com/en/copilot/reference/hooks-configuration
- https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/use-hooks
- https://opencode.ai/docs/permissions/
- https://opencode.ai/docs/server/
- https://developers.openai.com/codex/cloud
- https://ampcode.com/news/tool-level-permissions (Amp permissions, delegate; status per A7)
- https://github.com/littlebearapps/untether/issues/174 (secondary; Amp delegate status)
- Internal: `docs/analysis/ROADMAP.md` §1, D7, D11–D14, D25; `docs/adr/0008`, `0010`,
  `0013`, `0014`, `0015`; `docs/analysis/v2/SYNTHESIS.md`;
  `docs/analysis/v2/reports/04-agent-integration.md` §4.2, §4.5, §5 (R1, R2, R7, R10)
