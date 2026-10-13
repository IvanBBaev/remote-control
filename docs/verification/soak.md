# Soak (M1-15)

A long run of the real relay, agent and a headless phone in one process, with one
`PermissionRequest` from fake Claude Code a minute (ROADMAP M1-15, 03 W14, 07 #15). It
looks for memory growth, broken reconnects and duplicate decisions.

**Status: pending the owner.** The soak harness (`packages/test-harness/src/soak.ts`),
its CLI (`pnpm soak`) and a 30-round load smoke on every OS in CI are in place. The 24 h
run below has not been made yet.

## What is checked

| Id           | Holds when                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `allow`      | every round's hook answers `allow` (`Allowed N/N`, no failed round)                                                                    |
| `duplicates` | no request id gets more than one `decision_result` on the phone                                                                        |
| `reconnect`  | every agent drop (relay close 1012, every 15 rounds) is followed by exactly one new agent socket; the phone reconnects every 10 rounds |
| `rss`        | RSS growth from the end of warm-up (round 10) to the last sample is under 20 MB                                                        |
| `privacy`    | no run canary appears in relay or agent logs or in push bodies (I1)                                                                    |

Harness buffers (log lines, pushes, decrypted phone messages) are drained every round,
so they do not count as growth; every drained line still goes through the privacy gate.
Time inside the stack is a fake clock moved one second per wall second, so heartbeats,
backoff and expiry run as they would in production.

## How to run

1. `pnpm install`.
2. `NODE_OPTIONS=--expose-gc pnpm soak --hours 24 --out docs/verification/soak.md`
   (`--expose-gc` lets each RSS sample follow a full GC; the log says whether it did).
   Keep the machine awake (`caffeinate -i` on macOS).
3. Progress goes to stderr every 10 rounds; at the end the run appends a log entry below
   and exits 0 on PASS, 1 on FAIL.

Other flags: `--rounds N` (instead of `--hours`), `--interval-s` (default 60),
`--rss-limit-mb` (default 20).

## CI load smoke

The `agent-os-matrix` job runs `pnpm soak --rounds 30 --interval-s 5` on Ubuntu, macOS
and Windows with `continue-on-error` and writes the outcome and the log to the job
summary. It does not gate a merge; a red smoke is a lead for the next soak.

## Results
