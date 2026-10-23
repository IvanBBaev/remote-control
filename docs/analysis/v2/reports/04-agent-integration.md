# v2.0 analysis 04 — Agent integration

Status: 2026-10-24. Role: senior agent-integration engineer. Nothing here is a decision;
decisions come from a v2 roadmap ratified by the owner. Base: v1 report
`docs/analysis/reports/04-agent-integration.md` (not repeated), ROADMAP D11–D13, ADRs
0008, 0013, 0014, 0015, `docs/analysis/v2/00-brief.md`.

## 1. Summary

- The v1 adapter boundary (one `AgentAdapter`, three decision kinds) holds for approvals but
  is too narrow for fleets, budgets and schedules. 2.0 needs a split into small capability
  ports, not a rewrite.
- Claude Code now exposes far more than v1 uses: 33 hook events, `defer`, `PermissionDenied`,
  `claude --bg` agent view with worktree isolation, local `/loop`, cloud scheduled tasks.
  Cloud scheduled tasks run on Anthropic infrastructure and are unreachable by our hooks (I3-safe: we only observe).
- Recommended 2.0 agent theme: "fleet and guardrails", not "more agents". Add a fleet view
  (parent/child, blocked-first), agent-side budget and rate guardrails, batched approvals and
  agent-computed summaries. Keep Codex/Gemini at their v1 depth plus Codex follow-up.
- Budget: dollars are client-side estimates only; enforce through the next PermissionRequest
  (deny/handoff) and `stop`, never through new CLI flags (D13 argv gate stays).
- Learned allow rules: the agent only proposes; a rule applies after an explicit phone tap
  and is written via `updatedPermissions` (Claude only). I4 preserved.
- No relay-side scheduler or summariser (I1, I3). Scheduling is agent-local sealed commands.
- 9 work items (~5 S/M, 3 M/L); first two are protocol-only and unblock the rest.

## 2. Verified facts

All checked 2026-10-24 unless marked. Anything not listed here is in §3.

### Claude Code
- F1. Hooks: 33 events; 5 hook types (command, http, mcp_tool, prompt, agent); PreToolUse
  can return `defer`; `PermissionDenied` supports `retry`; `onFailure: "block"` exists
  (v2.1.295+); hooks can be shipped via managed settings.
  https://code.claude.com/docs/en/hooks (about 100k of 280k characters read; the rest is unverified)
- F2. Agent view: `claude --bg`, `--bg --exec`, `/bg`, `/fork`, `respawn`; background sessions
  get git-worktree isolation by default (`worktree.bgIsolation`); the supervisor stops idle
  sessions after about 1 h; a 48 h restart rule; per-session quota; research preview.
  https://code.claude.com/docs/en/agent-view
- F3. Local scheduling: `/loop` (CronCreate/List/Delete, 50 tasks, 7-day expiry, jitter, no
  catch-up, ScheduleWakeup); Desktop scheduled tasks run on the machine.
  https://code.claude.com/docs/en/scheduled-tasks
- F4. Cloud scheduled tasks (formerly routines): research preview; run on Anthropic
  infrastructure; triggers schedule (min interval 1 h), API (`POST .../fire` with a per-task
  bearer token, beta header `experimental-cc-routine-2026-04-01`) and GitHub events; each run
  is a new full cloud session; runs start in auto mode; a run waits for a prompt after 3
  consecutive or 20 total auto-mode blocks or on an ask rule; limits: 100 scheduled runs/h per
  account, 30 Run-now/API fires/h per task, 100 API fires/h per account; runs draw on
  subscription usage; `/schedule` needs a claude.ai subscription login, not an API key.
  https://code.claude.com/docs/en/routines
- F5. Auto mode: a classifier (default Claude Sonnet 5) reviews actions; blocks e.g. force push,
  `curl | bash`, production deploys; reads and working-directory edits skip it; explicit ask
  rules still prompt; after 3 consecutive or 20 total blocks it falls back to prompting
  (thresholds not configurable); in non-interactive `-p` runs a blocked action is simply not
  run. Blanket `Bash(*)` and `Agent` allow rules are dropped on entering auto mode.
  https://code.claude.com/docs/en/permission-modes (last 6k characters unread; PermissionRequest
  interaction with auto mode not confirmed on this page)
- F6. Plugins can ship hooks, mcpServers, agents, skills, channels, experimental monitors and
  `userConfig` (sensitive values in secure storage).
  https://code.claude.com/docs/en/plugins-reference

### Agent SDK
- F7. Options include `maxBudgetUsd` (client-side estimate; can be exceeded), `maxTurns`,
  `permissionMode` (default, acceptEdits, bypassPermissions, plan, dontAsk, auto) and `agents`
  (AgentDefinition). https://code.claude.com/docs/en/agent-sdk/typescript (about 100k of 302k read)
- F8. `total_cost_usd` and `costUSD` are client-side estimates from a bundled price table, "not
  authoritative billing data"; success and error result messages both carry `total_cost_usd`,
  `usage` and `modelUsage` (per model, with `costBasis`); `total_cost_usd` includes subagent
  spend, `usage` excludes it; a resumed session's result includes earlier spend; after a crash
  the cost fields may be zero; `error_max_budget_usd` is a result subtype.
  https://code.claude.com/docs/en/agent-sdk/cost-tracking

### Codex CLI
- F9. Hook trust is bound to the hook hash (a changed hook is skipped until re-trusted);
  `updatedInput`, `updatedPermissions` and `interrupt` are reserved and fail closed; events
  include Interrupt, SubagentStart, SubagentStop, PostCompact; `mcp_tool` hooks and async
  handlers exist; managed hooks via `requirements.toml`. https://learn.chatgpt.com/docs/hooks
- F10. Non-interactive: `codex exec resume <SESSION_ID>`, `--json`, `--ephemeral`,
  `--skip-git-repo-check`. https://developers.openai.com/codex/noninteractive (known from
  search snippets; the page body, approval behaviour and app-server protocol not read)

### Gemini CLI
- F11. 11 hook events; no approval hook; Notification is observe-only.
  https://geminicli.com/docs/hooks/reference/
- F12. A policy engine with TOML rules and approval modes default, auto_edit, yolo, plan.
  https://geminicli.com/docs/reference/policy-engine/ (secondary confirmation only)

## 3. Assumptions (not verified)

- A1. `claude -p --max-budget-usd` exists (third-party mentions only). Irrelevant under D13
  unless an ADR amends the argv gate.
- A2. Cloud-task run caps per plan (5/15/25 per day) seen in third-party posts conflict with the
  official hourly limits in F4; treat the official page as authoritative and the daily figures as stale.
- A3. Gemini ACP (`--acp`, `session/request_permission`) is a possible approval path. Source: one
  secondary page. Must be spiked before any design depends on it.
- A4. Codex approvals in `exec` mode and the app-server protocol can surface approval requests
  to a client. Not confirmed.
- A5. `claude agents --json` keeps the v1 shape (id, name, state, cwd) and exposes a state for
  "blocked on permission". Needs a re-check at M-start against the installed version.
- A6. SubagentStart/SubagentStop and TaskCreated/TaskCompleted payloads carry a parent session id.
  Not read from the hooks page.
- A7. Subscription users get no dollar figure from the CLI; only SDK/API-key sessions get
  `total_cost_usd`. Inferred from F8 plus ADR 0015 (API key only for the SDK adapter).
- A8. A phone user wants a single "blocked now" queue more than a tree of sessions.
- A9. LLM-written summaries on the agent are acceptable only when the owner has an API key and
  opts in; otherwise deterministic templates.

## 4. Findings

### 4.1 More agents
- Claude Code remains the only agent with the full set (allow, deny, handoff, questions,
  start, follow-up, diffs). Codex lacks "Always", answers and follow-up (ADR 0008). Gemini is
  deny-only (ADR 0013, F11).
- Cheapest real gain: Codex follow-up through `codex exec resume` (F10), flagged by
  `instructSupported` per version. Needs a spike on A4 first.
- Codex hash-bound trust (F9) means any change to our installed hook (including a version bump)
  silently disables it. v1 has a trust canary; 2.0 should make the installer idempotent by hash
  and make the canary a visible "agent not gating" state on the phone, not a log line.
- Gemini: only worth upgrading if ACP or the policy engine gives a real allow path (A3, F12).
  Until verified, keep deny-only. Do not add a fourth agent in 2.0; the capability matrix
  already shows honest limits.
- A new agent costs one adapter plus a trust canary plus a fake for the test harness. The
  boundary, not the agent count, is the scarce thing (§4.5).

### 4.2 Fleet, long-running and scheduled jobs
- Claude's agent view (F2) already is the process supervisor. We should observe and command it
  (`agents --json`, `--resume ... --bg`, stop/respawn), not build our own.
- Worktree isolation of bg sessions (F2) changes the working directory a session reports. The
  diff viewer and workspace-trust gate must key on the session's actual cwd, not the project root.
- The supervisor idles sessions after about 1 h and restarts within 48 h (F2). A long job may
  look "gone" on the phone. The session model needs states `idle-stopped` and `restartable`
  distinct from `ended`.
- Subagents: SubagentStart/Stop events exist on Claude (F1, A6) and Codex (F9). A parent/child
  edge is enough; do not mirror the full subagent DAG (that is the agenthropic project's scope).
- Scheduling has three surfaces: cloud tasks (F4), Desktop tasks and `/loop` (F3). Cloud tasks
  never hit our hooks; their sessions appear only on claude.ai. We can offer a deep link and,
  at most, count fires via the API trigger if the owner holds the token (we must not store it
  in the relay). Local `/loop` fires inside a session, so its tool calls already pass through
  our hooks; surface them with an `origin: "schedule"` tag.
- A cloud task's run starts in auto mode (F4, F5): the classifier decides, and a phone prompt
  exists only after repeated blocks. This is a different approval regime and should be shown as
  such, not as a normal pending request.
- Our own scheduling (run prompt X at time T) is feasible as an agent-side sealed command queue
  that calls the existing `start`. It must run on the home daemon only. A relay cron would need
  plaintext prompts or authority (violates I1/I3).

### 4.3 Budget guardrails
- Dollar accuracy is weak by documentation (F8). Guardrails must be framed as estimates and
  limits, never as billing.
- Only SDK/API-key sessions produce `total_cost_usd` (A7). For hook-driven CLI sessions we can
  only count what we see: number of approvals, tool calls, wall-clock, bg sessions running.
- Enforcement points that need no new flags: (a) the next PermissionRequest (return deny or
  handoff with a reason), (b) `claude stop` or the equivalent command for the whole session,
  (c) for SDK sessions, `maxBudgetUsd`/`maxTurns` as options of our own adapter (not CLI argv,
  so the D13 gate is untouched).
- Guardrails that already exist upstream: auto-mode thresholds (F5), cloud task hourly limits
  (F4), per-session bg quota (F2). We must not duplicate them, only display them.
- The default stance for a budget breach should be "stop asking and notify", not "kill":
  killing a session mid-write can corrupt a working tree. Hard stop is opt-in per rule.

### 4.4 Smarter approvals
- Batching: N pending requests from one session or one fleet can be shown together, but each
  keeps its own sealed decision (own nonce, own assertion check). A batch is a UI grouping plus
  a shared `batchId`, not one signature over many. This keeps I4 and the v1 replay model.
- Summaries: the agent already has the full `tool_input`. A deterministic template (tool,
  path, command head, risk tags such as "writes outside repo", "network", "git push") covers
  most value with no model call. LLM summaries (A9) are opt-in and must run on the agent with
  the owner's key; the relay never sees plaintext.
- Risk hints are advisory input to the human; they never auto-decide (I4). They may reorder the
  queue (blocked and risky first).
- Learned rules: the agent mines its own local decision history (never uploaded) and proposes
  "allow `Bash(npm test)` for this project". Applied only after a phone confirm, written as
  `updatedPermissions` on Claude. Codex reserves that field and fails closed (F9), so Codex gets
  session-scope only (D24). Rules must be narrow; Claude drops broad interpreter rules in auto
  mode (F5), so proposing broad rules is both unsafe and ineffective.
- New Claude signals worth wiring: `PermissionDenied` with `retry` (F1) lets the phone say
  "retry this blocked action" after an auto-mode denial; `defer` in PreToolUse (F1) is the clean
  "ask a human later" primitive for headless runs. Both need a spike on payloads (not read in full).
- `onFailure: "block"` (F1) would deny when our hook is unreachable. It is the opposite of our
  fail-open-to-terminal stance. Offer as an opt-in strict mode only; default stays handoff.

### 4.5 What the adapter boundary must change
Current: one fat `AgentAdapter` (detect, installHooks, onHook, decide, listSessions, start,
followUp) with capability flags. Pressure points for 2.0:
1. Fleet needs `stop`, `respawn`, `parentId`, `isolation`, `origin` on sessions.
2. Budget needs a `cost`/`limit` event kind and a policy hook point before `decide`.
3. Schedule needs `origin: "schedule"` and an agent-local queue, not an adapter method.
4. Batching needs `batchId` and `scope` on decisions.
5. Non-hook transports (SDK, `codex exec --json`, possibly ACP) are already outside the
   "hook script calls loopback" model; ADR 0015 is the first, not the last.
Proposed split (capability ports, each optional per adapter):
- `ApprovalPort`: onHook, decide (as today, plus `batchId`, `scope`).
- `SessionPort`: list, start, followUp, stop, respawn (new commands guarded by flags).
- `FeedPort`: event stream with new kinds `subagent`, `task`, `cost`, `limit`, `schedule`.
- `InstallPort`: detect, install, verify (hash-aware), report trust state.
The agent core adds a `GuardrailPolicy` module between `ApprovalPort` and the phone; adapters
stay unaware of budgets. Versioned capability negotiation (per CLI version) replaces boolean flags
where a feature depends on a version (for example `--resume --bg` needs v2.1.257+).

## 5. Recommendations

R1. Split the adapter into the four ports above; keep `AgentAdapter` as a composition so v1
adapters keep working. Rejected: a rewrite per agent (no benefit), a plugin-per-agent runtime
loader (more surface, no second developer).
R2. Add fleet fields and commands (`parentId`, `isolation`, `origin`, `stop`, `respawn`) and a
"needs you" ordering. Rejected: own supervisor/process manager (agent view already is one, F2);
full subagent DAG (out of scope, belongs to agenthropic).
R3. Guardrail policy on the agent: counters (approvals/min, tool calls, wall-clock, running bg
sessions) and optional SDK `maxBudgetUsd`. Action ladder: notify, then deny next request, then
stop (opt-in). Rejected: relay-side budget enforcement (I3); trusting dollars from the CLI (F8);
adding `--max-budget-usd` to argv (A1, D13).
R4. Batching as a UI group with one sealed decision per item. Rejected: one decision signing a
set (breaks per-request replay protection and I4 audit).
R5. Deterministic summaries and risk tags by default; LLM summary opt-in on the agent with the
owner's API key. Rejected: relay or phone-side LLM (I1), always-on LLM summary (cost, privacy).
R6. Learned rules as agent-proposed, phone-confirmed, Claude-only `updatedPermissions`, narrow
patterns only. Rejected: silent auto-allow from history (violates I4); cross-user shared rules
(Teams scope, report on policy).
R7. Scheduling: agent-local queue of sealed `start` commands plus read-only observation of
`/loop`, Desktop and cloud tasks (deep link to claude.ai). Rejected: relay cron (I1/I3); calling
the cloud `/fire` endpoint from the relay (token custody, beta header, I3).
R8. Codex: add follow-up via `exec resume` after spike A4; make hash-drift a visible state.
Gemini stays deny-only until A3 is proven. Rejected: a fourth agent in 2.0.
R9. Keep fail-open-to-terminal as default; expose `onFailure: "block"` only as opt-in strict
mode. Rejected: making it the default (a down daemon would deadlock every agent).
R10. Treat the cloud-task approval regime (auto mode) as a separate read-only card type.

## 6. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| K1 | Agent view and cloud tasks are research previews; flags and JSON shape change | High | Medium | Per-version capability probe; contract tests against a recorded `agents --json` fixture; degrade to v1 features |
| K2 | Worktree isolation breaks cwd to project mapping (diffs, trust gate) | Medium | High | Resolve by session cwd; add a fake-claude-code scenario with isolation on |
| K3 | Cost estimates mislead (F8), user trusts a budget that does not hold | Medium | Medium | Label "estimate"; prefer count/time limits; never block billing decisions on it |
| K4 | Learned rule too broad becomes a permission hole | Medium | High | Narrow-pattern linter, per-project scope, expiry, phone shows exact pattern, audit entry |
| K5 | Hard stop corrupts a working tree | Low | High | Default to notify/deny; stop is opt-in; show dirty-tree warning |
| K6 | Codex hook hash drift silently disables gating | Medium | High | Hash-aware installer, canary state on the phone |
| K7 | Batch UI invites rubber-stamping | Medium | Medium | Cap batch size, show per-item risk, require item expand for high-risk tags |
| K8 | Scope creep into a general agent orchestrator | High | Medium | Stay observer/approver; link out to claude.ai for cloud runs |
| K9 | Unread portions of docs hide breaking details (hooks 280k, SDK 302k) | Medium | Medium | First work item is a doc-diff spike with recorded fixtures |
| K10 | `defer`/`PermissionDenied` semantics differ from assumption | Medium | Low | Spike before use; feature-flagged |

## 7. Work items

Sizes: S under 1 day, M 1–3 days, L 3–5 days (one developer plus AI executor). IDs are
provisional (`V2-AG-nn`); the synthesising roadmap may renumber.

- V2-AG-01 (S, deps: none) Spike and fixtures: record `claude agents --json`, SubagentStart/Stop,
  TaskCreated, PermissionDenied and PreToolUse `defer` payloads into `packages/fake-claude-code`
  fixtures; settle A5, A6, K10.
  AC: `pnpm check` green; fixtures under `packages/fake-claude-code/fixtures/` each referenced by a
  test; a markdown table in the spike note lists every field the adapter reads.
- V2-AG-02 (M, deps: 01) Protocol: add `parentId`, `isolation`, `origin`, `batchId`, `scope`
  and event kinds `subagent|task|cost|limit|schedule`; old clients ignore unknown kinds.
  AC: protocol schema tests pass; a v1 fixture still parses; a golden test shows an unknown kind
  is dropped without error.
- V2-AG-03 (M, deps: 02) Port split: `ApprovalPort`, `SessionPort`, `FeedPort`, `InstallPort`;
  `AgentAdapter` becomes a composition; no behaviour change.
  AC: all existing adapter tests pass unchanged; `grep -r "implements AgentAdapter" apps/agent/src`
  returns only the composition helper.
- V2-AG-04 (M, deps: 03) Claude fleet: stop, respawn, parent/child from subagent events,
  `idle-stopped`/`restartable` states, cwd-by-isolation for diffs.
  AC: fake-claude-code scenario "bg session with worktree" yields a diff from the worktree path;
  `stop` and `respawn` commands appear in the capability matrix only when probed.
- V2-AG-05 (M, deps: 03) GuardrailPolicy: counters, config in `remotectl` settings, action
  ladder notify/deny/stop, `limit` events; SDK adapter passes `maxBudgetUsd`/`maxTurns`.
  AC: unit tests for each rung; static gate still passes with the forbidden-token list unchanged
  (`--dangerously-skip-permissions`, `bypassPermissions`, `--allowedTools`, `--settings`); a test
  proves a deny from policy never reaches an allow path.
- V2-AG-06 (S, deps: 02) Deterministic summary and risk tags per tool call, computed on the agent
  and sealed with the request.
  AC: table-driven tests cover Bash, Edit/Write, git push, network, path outside repo; the relay
  test-harness asserts the payload stays opaque (no summary field in plaintext metadata).
- V2-AG-07 (M, deps: 02, 06) Batched approvals: group by session/fleet, one sealed decision per
  item, cap of N items.
  AC: replaying one decision for another item is rejected; end-to-end test with 3 items yields 3
  independent assertions.
- V2-AG-08 (L, deps: 05, 06) Learned-rule proposals: local decision history, narrow-pattern
  generator, linter rejecting wildcard interpreters, phone confirm, `updatedPermissions` on
  Claude only, session scope on Codex.
  AC: generator never emits `Bash(*)` or interpreter wildcards (property test); no rule is written
  without a confirm event (integration test); history file never leaves the agent (network-egress
  test with the relay stub).
- V2-AG-09 (M, deps: 03, 01) Codex hardening: hash-aware installer, visible trust state, and
  `exec resume` follow-up behind `instructSupported` after spike A4; optional Gemini ACP spike
  (A3) as a separate S item.
  AC: changing the hook file flips trust state to "not gating" in a test; follow-up test uses a
  recorded `codex exec --json` fixture; ADR 0008/0013 amendments listed if behaviour changes.
- V2-AG-10 (S, deps: 04) Schedule observation and queue: `origin: "schedule"` tag for `/loop`
  sessions, deep link card for cloud tasks, agent-local queue of sealed `start` commands.
  AC: a queued command fires at the stored time on the agent with the relay offline; the relay
  database contains no prompt text (schema/e2e test).

## 8. Open questions for the owner (defaults apply until answered)

- Q1. Do you use cloud scheduled tasks or `/loop` enough to justify observation? Default: yes for
  `/loop` tagging, deep link only for cloud tasks.
- Q2. Are your CLI sessions on a subscription or an API key? Default: subscription, so guardrails
  use counts and time, dollars only for SDK sessions.
- Q3. Is an opt-in LLM summary acceptable (needs API key on the agent)? Default: no, deterministic only.
- Q4. May the policy ladder stop a session? Default: notify and deny only; stop is off.
- Q5. Is `onFailure: "block"` strict mode wanted? Default: off.
- Q6. Should learned rules be Claude-only in 2.0? Default: yes.
- Q7. Is Codex follow-up worth a spike now? Default: yes if A4 confirms in under one day.
- Q8. Is a Gemini allow path (ACP or policy) worth a spike? Default: no, stay deny-only.

## 9. Sources

- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/agent-view
- https://code.claude.com/docs/en/scheduled-tasks
- https://code.claude.com/docs/en/routines
- https://code.claude.com/docs/en/permission-modes
- https://code.claude.com/docs/en/plugins-reference
- https://code.claude.com/docs/en/agent-sdk/typescript
- https://code.claude.com/docs/en/agent-sdk/cost-tracking
- https://learn.chatgpt.com/docs/hooks (redirect from https://developers.openai.com/codex/hooks)
- https://developers.openai.com/codex/noninteractive
- https://geminicli.com/docs/hooks/reference/
- https://geminicli.com/docs/reference/policy-engine/
- Repo: `docs/analysis/reports/04-agent-integration.md`, `docs/analysis/ROADMAP.md` D11–D13, D24,
  `docs/adr/0008`, `0013`, `0014`, `0015`.
