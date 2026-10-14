# Real Gemini CLI hook verification (04 W14)

Checks the Gemini adapter against the real `gemini` CLI (ROADMAP M3 backlog, 04 W14,
04 §2.12, ADR 0013). Not part of CI: it needs an installed, logged-in Gemini CLI and an
owner at the terminal.

**Status: pending the owner.** `gemini` was not installed when the adapter was built. The
golden tests (`apps/agent/src/adapters/gemini/adapter.test.ts`) and the harness journey
(`packages/test-harness/src/journeys/j2-gemini.test.ts`) cover the documented shapes.

## What is checked

| Id        | Assumption                                                                   | Holds when                                                                 |
| --------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `version` | The verified Gemini CLI version is recorded                                  | `gemini --version` output is written below                                 |
| `install` | `remotectl hooks install --agent gemini` writes hooks Gemini loads           | `remotectl status` shows "a Gemini hook arrived" after a new session       |
| `matcher` | Only `run_shell_command`, `write_file` and `replace` are held                | a `read_file` call reaches no phone; a shell command does                  |
| `hold`    | `timeout: 1800000` (ms) on `BeforeTool` is honoured beyond 60 s              | the hook is still connected after 120 s and the phone's deny still applies |
| `deny`    | `{"decision":"deny","reason":…}` blocks the call and shows the reason        | the marker file is not created and Gemini shows the reason                 |
| `allow`   | `{}` (a phone allow) leaves the call to Gemini's own confirmation (04 A6)    | Gemini shows its confirmation dialog in the terminal                       |
| `feed`    | `SessionStart`, `AfterTool` and `SessionEnd` arrive with `session_id`, `cwd` | the session appears on the phone and shows as ended after `/quit`          |

## How to run

1. `pnpm install && pnpm build`, install the agent and pair a phone (M1-01).
2. `remotectl hooks install --agent gemini`, then start `gemini` in a scratch git repo.
3. Ask Gemini to read a file, then to run `touch remotectl-gemini-marker`. Answer from
   the phone for each row above.
4. Record the results below. A result that contradicts ADR 0013 becomes a new ADR.

## Results

| Id  | Result | Notes |
| --- | ------ | ----- |
|     |        |       |
