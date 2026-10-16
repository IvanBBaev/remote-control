# ADR 0013 — Gemini adapter: observe and deny only, gate on mutating tools

Status: accepted (M3 backlog, 04 W14, 2026-10-14)
Deviates from: 04 §5.9 (an unmatched `BeforeTool` gate, and `allow` sent to Gemini)

## Context

Gemini CLI has no approval hook (04 §2.12). `BeforeTool` can block a tool call with
`{"decision":"deny","reason":…}`, and `reason` is required on a deny. Its `allow` does not
answer Gemini's own confirmation dialog (04 A6). 04 §5.9 plans a `BeforeTool` hook with
`timeout: 1800000` and no matcher, which "passes allow to Gemini's own confirmation", and the
honest label "observe and deny only".

Two details of that plan do not hold up:

- `BeforeTool` fires for every tool call, including `read_file`, `glob` and
  `list_directory`. Without a matcher, every read would wait on the phone for up to 30
  minutes.
- What an `allow` does across Gemini versions is exactly what A6 leaves open. If a later
  Gemini honoured it, the phone would grant calls behind a label that says it cannot.

`gemini` is not installed on the machine that built this, so
`docs/verification/gemini.md` cannot be filled yet. As with ADR 0005 and ADR 0008, the
code does not wait for it.

## Decision

- **Gate scope.** `BeforeTool` uses the matcher `^(run_shell_command|write_file|replace)$`.
  These are the built-in tools that run commands or change files. Read-only and MCP tools
  are not held.
- **Deny only.** A phone deny returns `{"decision":"deny","reason":<phone reason or
"Denied from phone">}`. Every other answer returns `{}`: allow, "always", a question
  answer and a handoff. Gemini then shows its own confirmation, so the phone never grants a
  call. The tool input is never rewritten (D11).
- **Timeouts.** Gemini hook timeouts are in milliseconds. The installer writes
  `holdSeconds × 1000` for the gate and 5000 for the feed hooks. The `hook.cjs T` argument
  stays in seconds.
- **Feed.** `AfterTool`, `Notification`, `SessionStart` and `SessionEnd` only feed the
  session list. The Claude Code feed mapping (timeline, activity counters) does not read
  Gemini event names yet.
- **Routing and capabilities.** `hook.cjs T --adapter gemini` sends
  `x-remotectl-agent: gemini`. The Gemini capability flags are all `false`. They are
  advertised only while `~/.gemini/settings.json` holds the complete remotectl entries.
- **Canary.** `gemini-hooks-seen.json` records the first hook of each event, and
  `remotectl status` reports "a Gemini hook arrived". Gemini sessions take no follow-ups.

## Consequences

- The phone shows Allow and Deny for a Gemini request. Allow acts as "decide in the
  terminal". The PWA does not yet show the "observe and deny only" label. That needs a
  capability flag in the protocol, which is a separate change.
  Update: the optional capability `allow: false` and `ApprovalRequest.allowSupported:
false` now mark a Gemini request deny-only. The card shows the label and no Allow.
- A new mutating built-in tool in Gemini is not gated until the matcher lists it.
- A real-CLI result that contradicts this ADR becomes a follow-up ADR. Only
  `decideGemini`, the matcher and their tests change.
