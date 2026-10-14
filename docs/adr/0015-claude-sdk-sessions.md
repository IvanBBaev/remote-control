# ADR 0015 — Claude Code sessions through the Agent SDK for API-key users

Status: accepted (M3 backlog, 04 W15, 2026-10-14)
Deviates from: 04 §2.9 (an SDK allow that returns `updatedInput`, and an SDK handoff)

## Context

04 W15 plans a second way to run Claude Code sessions. API-key users run them through the
Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) instead of `claude --bg`, and approvals
go through `canUseTool`. Policy SDK-O allows this only on an API key. A claude.ai
subscription login must keep using the CLI.

Three facts shape the design:

- The package is about 5 MB, and its platform binaries add about 235 MB. Most users never
  need it, so a hard dependency of `remotectl` would make every install heavier.
- `canUseTool` may answer with `updatedInput`. The argv policy (rule 4) keeps
  `updatedInput` to the Claude Code `decide.ts` mapping, which uses it only for
  `AskUserQuestion` answers (D11). A second producer would weaken that gate.
- An SDK session has no terminal. A handoff or a pause, which a CLI hook answers with
  `{}` so the terminal asks, has nowhere to go.

## Decision

- **Opt-in.** `agent.sessions` in `config.json` is `"cli"` (default) or `"sdk"`. In
  `"sdk"` mode the phone's start and follow-up both go through the SDK. Sessions the user
  started in a terminal still report through their settings-file hooks.
- **Optional peer, lazy import.** `remotectl` names the SDK as an optional peer in
  `peerDependenciesMeta` only. A version range in `peerDependencies` made pnpm's
  `auto-install-peers` pull in the SDK and its binaries, so the range is left out. The
  code is typed against 0.3.292. The SDK is loaded with `import()` on the first SDK start
  only. Without the package, a start fails and logs `sdk_unavailable`.
- **The key lives in the environment only.** The agent never reads or writes the key in a
  config file. It passes its environment to the SDK and starts nothing unless
  `ANTHROPIC_API_KEY` is set (`sdk_no_api_key`). It accepts a session only when the init
  message reports `apiKeySource: "ANTHROPIC_API_KEY"`. Any other source (a `/login` key,
  `apiKeyHelper`, `none`) closes the query and logs `sdk_auth_refused`.
- **One dispatcher.** `canUseTool` sends a synthetic `PermissionRequest` through the same
  hook dispatcher, pending store and E2E path as a CLI hook. The decision is read back
  from `decide.ts`'s output:
  - allow returns `{behavior: "allow"}`, never with `updatedInput`, so the tool runs on
    the input the SDK asked about;
  - "Always" keeps its `updatedPermissions`;
  - deny keeps its message.

  The SDK's `suppressAlwaysAllowRule` drops the "Always" suggestions.

- **Questions through a hook.** `AskUserQuestion` is held by an SDK `PreToolUse` hook
  callback (matcher `^AskUserQuestion$`), which returns the dispatcher's output unchanged,
  as `hook.cjs` would. `updatedInput` therefore stays in `decide.ts`. If the question
  reaches `canUseTool` (no answer), it is denied.
- **No handoff.** No decision (a deadline handoff, a pause, `{}`) becomes
  `{behavior: "deny", message: "No decision from phone"}`.
- **No double hooks.** The SDK reads `project` and `local` settings only, never `user`, so
  the user-level remotectl hooks do not fire a second time. The feed events are SDK hook
  callbacks with the same 5 s timeout. Dispatches carry `origin: "sdk"`, and the
  "hook seen" canary ignores them.
- **Roster.** SDK sessions join the CLI roster as background rows, after the CLI's.

## Consequences

- An SDK request that nobody answers is denied at the deadline. `agent.onExpire` has no
  effect on SDK sessions.
- `remotectl status` shows `sessions: sdk` and whether `ANTHROPIC_API_KEY` is set.
- The real SDK has not been run against this code yet; `docs/verification/claude-sdk.md`
  lists the checks. A result that contradicts this ADR becomes a follow-up ADR.
