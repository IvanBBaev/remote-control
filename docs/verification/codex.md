# Real Codex CLI hook verification (M2-01)

Checks the Codex adapter against the real `codex` CLI (ROADMAP M2-01, 04 W13, 04 §2.11,
ADR 0008). Not part of CI: it needs an installed, logged-in Codex and an owner at the
terminal.

**Status: pending the owner.** `codex` was not installed when M2-01 was built. The
golden tests (`apps/agent/src/adapters/codex/adapter.test.ts`) and the harness journey
(`packages/test-harness/src/journeys/j2-codex.test.ts`) cover the documented shapes.

## What is checked

| Id        | Assumption                                                                | Holds when                                                                       |
| --------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `version` | The verified Codex version is recorded                                    | `codex --version` output is written below                                        |
| `install` | `remotectl hooks install --agent codex` writes a `hooks.json` Codex loads | `/hooks` in `codex` lists the remotectl entries                                  |
| `trust`   | Untrusted hooks do not run; trusting them in `/hooks` enables them        | `remotectl status` shows "a Codex hook arrived" only after trusting              |
| `hold`    | `timeout: 1800` on `PermissionRequest` is honoured beyond 600 s           | the hook is still connected after 660 s and the phone's `allow` runs the command |
| `allow`   | `decision.behavior: allow` lets the command run without a terminal prompt | the marker file is created                                                       |
| `deny`    | `decision.behavior: deny` + `message` blocks the command                  | the marker file is not created and Codex shows the message                       |
| `handoff` | No output (`{}`) leaves the decision to Codex's own prompt                | "Reply in terminal" on the phone brings the prompt back in `codex`               |
| `feed`    | Feed events arrive with `session_id`, `cwd`, `turn_id`                    | the session appears on the phone's session list as a Codex session               |
| `end`     | `SessionEnd` finishes within its 3 s cap                                  | the session shows as ended after `/quit`                                         |

## How to run

1. `pnpm install && pnpm build`, install the agent and pair a phone (M1-01).
2. `remotectl hooks install --agent codex`. Start `codex` in a scratch git repo, open
   `/hooks` and trust the remotectl entries.
3. Use `approval_policy = "on-request"` and ask Codex to run
   `touch remotectl-codex-marker`. Answer from the phone for each row above.
4. Record the results below. A result that contradicts ADR 0008 becomes a new ADR.

## Results

| Id  | Result | Notes |
| --- | ------ | ----- |
|     |        |       |
