# Real Claude Code hook verification (M0-23)

Checks the hook assumptions the agent is built on against the real `claude` CLI
(ROADMAP M0-23, 04 W5, 04 W12, 04 A2–A3). Not part of CI: it needs an installed,
logged-in Claude Code and an owner at the terminal. The kit is
`tools/verify-claude-code.ts`; it never touches `~/.claude` or an installed remotectl.

**Status: pending the owner** — the hook overhead is measured (synthetic, below); the
real-CLI hold runs need a machine with `claude` on `PATH`. Any result that contradicts
D10 (blocking `PermissionRequest` hook, 1800 s timeout) or D11 (hook prints nothing
when there is no decision) becomes an ADR before M1-04 starts.

## What is checked

| Id         | Assumption                                                                  | Holds when                                                                                      |
| ---------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `version`  | The verified Claude Code version is recorded                                | `claude --version` output is written below                                                      |
| `A2`       | `timeout: 1800` on `PermissionRequest` is honoured beyond the 600 s default | the hook is still connected after 660 s and its `allow` lets the command run                    |
| `A3`       | While the hook holds, the terminal shows no permission prompt               | nothing to answer in the terminal until the hook returns                                        |
| `deny`     | A `deny` answer from the hook blocks the tool and the turn continues        | the marker file is not created and Claude reports the denial                                    |
| `ctrl-c`   | Ctrl+C while the hook holds cancels the request cleanly                     | the receiver logs "hook disconnected"; the session stays usable; no orphaned `hook.cjs` process |
| `bg`       | The same holds for a background session (`claude --bg`)                     | `claude agents --json --all` shows the session waiting while held and done after the answer     |
| `overhead` | A hook adds little to a tool call (04 W12)                                  | p95 of the `hook.cjs` round trip < 150 ms over 200 calls                                        |

The decision comes from the kit's loopback receiver in place of the phone, which 04 W5
allows ("decided from a test client"); the phone path is covered end to end by M1-04.

## How to run

1. `pnpm install && pnpm build` (the kit copies `apps/agent/dist/hook.cjs`).
2. Overhead: `pnpm exec tsx tools/verify-claude-code.ts overhead [--runs 200]`. It
   alternates a bare `node -e ""` start with a `hook.cjs` PostToolUse round trip against
   a loopback receiver that answers 204, and prints the table below plus PASS/FAIL.
3. Hold: `pnpm exec tsx tools/verify-claude-code.ts hold [--hold-seconds 660]
[--decision allow|deny]`. It creates a temp git repo with only the
   `PermissionRequest` hook in `.claude/settings.json` (timeout 1800 s), starts the
   receiver and prints the `claude` command to run there. That command passes
   `--setting-sources project,local`, so the hooks of an installed remotectl in
   `~/.claude/settings.json` do not answer first. Trust the folder when Claude Code asks
   (`claude --bg` refuses an untrusted folder, so start it interactively once).
4. Approve nothing in the terminal. The receiver logs when the hook arrives, answers
   after the hold, and 30 s later reports whether `rc-verified.txt` exists.
5. Repeat with `--decision deny`, then once more pressing Ctrl+C during the hold, then
   with the printed `--bg` command (poll `claude agents --json --all`).
6. Fill in the tables below and set the status.

## Results

### Hook overhead (synthetic, 2026-10-13)

Measured without Claude Code: `hook.cjs` spawned directly, so the numbers are the
hook's own cost (Node start, read `agent.json`, POST to the daemon, exit), which is what
Claude Code adds per tool call. Apple M5, macOS (Darwin arm64), Node v22.23.2, machine
under load (load average ≈ 14).

| Measured                          | Runs | p50     | p95     | max     |
| --------------------------------- | ---- | ------- | ------- | ------- |
| `node -e ""` (Node start)         | 200  | 19.5 ms | 25.8 ms | 29.5 ms |
| `hook.cjs` PostToolUse round trip | 200  | 25.4 ms | 31.9 ms | 54.5 ms |

hook p95 31.9 ms vs target < 150 ms: **PASS**. About 6 ms of the hook is its own work;
the rest is Node start-up.

### Real CLI (pending the owner)

Claude Code version: _pending_

| Id       | Outcome   | Detail (timings, what the terminal showed) |
| -------- | --------- | ------------------------------------------ |
| `A2`     | _pending_ |                                            |
| `A3`     | _pending_ |                                            |
| `deny`   | _pending_ |                                            |
| `ctrl-c` | _pending_ |                                            |
| `bg`     | _pending_ |                                            |
