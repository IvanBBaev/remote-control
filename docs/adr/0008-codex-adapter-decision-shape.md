# ADR 0008 — Codex adapter: decision shape and build ahead of the real-CLI check

Status: accepted (M2-01, 2026-10-13)
Deviates from: 04 §5.9 (the Codex `deny` output) and ROADMAP §4 dependency order (M2-01
depends on M1-05, whose real-CLI check is pending, ADR 0005)

## Context

04 §5.9 lists the Codex decisions as `{"hookSpecificOutput":{"decision":{"behavior":"allow"}}}`
and `{"hookSpecificOutput":{"permissionDecision":"deny"}}`. The second shape is the one
Codex documents for `PreToolUse` (04 §2.11). The agent holds only `PermissionRequest`,
whose documented output is `hookSpecificOutput.decision.behavior` `allow` | `deny`
(04 §2.11, "any deny wins"). A `permissionDecision` on a `PermissionRequest` answer
would be ignored, and Codex would fall back to its own prompt.

`codex` is not installed on the machine that built M2-01, so the manual log in
`docs/verification/codex.md` cannot be filled yet. As with ADR 0005 and ADR 0007, the code
does not wait for it.

## Decision

- **One shape for both answers.** Allow is
  `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`.
  Deny is the same with `"behavior":"deny"` and a `message` (the phone's reason, or
  "Denied from phone"). There is no `interrupt` field, because it is a Claude Code field.
- **Blocking scope.** Codex blocks only on `PermissionRequest`. `PreToolUse`,
  `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart` and `SessionEnd` only feed the
  session list. `SessionEnd` runs with a 3 s timeout, which is Codex's ceiling.
- **No grant the phone did not give.** "Always" and question answers become a handoff
  (`{}`), so Codex asks in its terminal. Codex has no question tool and no session rules
  that the agent could write.
- **Follow-ups refused.** A Codex session cannot receive a follow-up from the phone, because
  resuming Codex is unverified (04 §8). Codex sessions do not count as Claude Code trusted
  folders.
- **Routing.** `hook.cjs T --adapter codex` sends `x-remotectl-agent: codex`. The body
  stays verbatim. A missing header means Claude Code. An unknown value is refused with 400.
- **Capabilities.** The Codex capability flags are advertised only while
  `~/.codex/hooks.json` (or `$CODEX_HOME/hooks.json`) holds the complete remotectl entries.
- **Trust canary.** `codex-hooks-seen.json` records the first hook of each event.
  `remotectl status` reports "a Codex hook arrived" once any Codex hook has arrived. That
  only happens after the user has trusted the entries in `/hooks`.

## Consequences

- If the real CLI shows that `message` is rejected, or that `permissionDecision` is needed
  as well, only `decideCodex` and its golden tests change.
- M2-01 stays `done` (code) with the real-CLI log pending. A contradiction found there
  becomes a follow-up ADR.
