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
| `rss`        | the median of the last 3 RSS samples is under 20 MB above the median of the first 3 from the end of warm-up (1 h of rounds)            |
| `awake`      | the run made at least half the rounds its wall time allows (otherwise the machine slept and the run measures nothing)                  |
| `privacy`    | no run canary appears in relay or agent logs or in push bodies (I1)                                                                    |

Harness buffers (log lines, pushes, decrypted phone messages) are drained every round,
so they do not count as growth; every drained line still goes through the privacy gate.
Time inside the stack is a fake clock moved one second per wall second, so heartbeats,
backoff and expiry run as they would in production.

## How to run

1. `pnpm install`.
2. `NODE_OPTIONS=--expose-gc pnpm soak --hours 24 --out docs/verification/soak.md`
   (`--expose-gc` lets each RSS sample follow a full GC; the log says whether it did).
   Keep the machine awake and on power: `caffeinate -dims` on macOS, lid open (closing
   the lid or a low battery still sleeps the Mac, and a sleep shows up as hook latency
   spikes and a skewed RSS).
3. Progress goes to stderr every 10 rounds; at the end the run appends a log entry below
   and exits 0 on PASS, 1 on FAIL.

Other flags: `--rounds N` (instead of `--hours`), `--interval-s` (default 60),
`--rss-limit-mb` (default 20).

## CI load smoke

The `agent-os-matrix` job runs `pnpm soak --rounds 30 --interval-s 5` on Ubuntu, macOS
and Windows with `continue-on-error` and writes the outcome and the log to the job
summary. It does not gate a merge; a red smoke is a lead for the next soak.

## Results
