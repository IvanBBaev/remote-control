# Real Agent SDK verification (04 W15)

Checks SDK sessions (`agent.sessions: "sdk"`, ADR 0015) against the real
`@anthropic-ai/claude-agent-sdk` (ROADMAP M3 backlog, 04 W15). It is not part of CI,
because it needs an Anthropic API key and an owner with a paired phone.

**Status: pending the owner.** The SDK was typed against 0.3.292 but never run. The unit
tests (`apps/agent/src/adapters/claude-sdk/*.test.ts`) and the harness journey
(`packages/test-harness/src/journeys/j2-claude-sdk.test.ts`) use a stand-in SDK.

## What is checked

| Id         | Assumption                                                                   | Holds when                                               |
| ---------- | ---------------------------------------------------------------------------- | -------------------------------------------------------- |
| `version`  | The verified SDK version is recorded                                         | the installed `package.json` version is written below    |
| `load`     | The optional peer is found next to a global `remotectl`                      | a phone start runs and the log has no `sdk_unavailable`  |
| `key`      | The init message reports `apiKeySource: "ANTHROPIC_API_KEY"`                 | the session starts and the log has no `sdk_auth_refused` |
| `login`    | A `/login`-only machine (no key in the environment) starts nothing           | the log has `sdk_no_api_key`, and no API call is billed  |
| `allow`    | `canUseTool` → `{behavior:"allow"}` runs the tool with its input             | the marker file is created                               |
| `deny`     | `{behavior:"deny", message}` blocks the tool and shows the message to Claude | the marker file is not created                           |
| `question` | The `PreToolUse` hook's `updatedInput` answers `AskUserQuestion`             | Claude quotes the answer picked on the phone             |
| `always`   | `updatedPermissions` from "Always" is applied for the session                | a repeat of the same command reaches no phone            |
| `no-user`  | `settingSources: ["project","local"]` keeps the user-level hooks from firing | each request reaches the phone once                      |
| `followup` | A follow-up from the phone reaches the live query                            | Claude answers the follow-up in the same session         |

## How to run

1. `npm i -g remotectl @anthropic-ai/claude-agent-sdk`, then pair a phone (M1-01).
2. Set `"agent": { "sessions": "sdk" }` in `config.json`, then run the agent with
   `ANTHROPIC_API_KEY` in its environment (`remotectl run` in that shell).
3. From the phone, start a session in a scratch repository. Ask it to run
   `touch remotectl-sdk-marker`, then to ask a question with `AskUserQuestion`.
4. Record the results below. A result that contradicts ADR 0015 becomes a new ADR.

## Results

| Id  | Result | Notes |
| --- | ------ | ----- |
|     |        |       |
