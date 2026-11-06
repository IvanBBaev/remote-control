# Soak (M1-15)

A long run of the real relay, agent and a headless phone in one process, with one
`PermissionRequest` from fake Claude Code a minute (ROADMAP M1-15, 03 W14, 07 #15). It
looks for memory growth, broken reconnects and duplicate decisions.

**Status: pending the owner.** The soak harness (`packages/test-harness/src/soak.ts`),
its CLI (`pnpm soak`) and a 30-round load smoke on every OS in CI are in place. The first 24 h
run (below) failed and is not a valid measurement (the machine slept); a rerun is due.

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

## 2026-10-29T22:29:51.667Z — FAIL

- Node v24.22.1, darwin/arm64; GC exposed: yes
- Wall time 31.97 h, 358 rounds, one request every 60 s
- Allowed 358/358; duplicate decisions 0; canary leaks 0
- Phone reconnects 35; agent drops 23, agent reconnects 23
- Hook round trip p50 31 ms, p99 34131 ms, max 58384 ms
- RSS baseline 77.0 MB, growth 25.0 MB (limit 20 MB)
- Verdict: RSS grew 25.0 MB (limit 20 MB)
- Not a valid 24 h measurement: the Mac slept after about 6 h (358 rounds in 31.97 h;
  the p99 and max latency are the sleeps). The heap grew 3.8 MB over the run; the
  retained objects were decision hashes in the relay's in-memory challenge ledger,
  pruned only at its 10 000-entry cap — fixed in 256e77e. Most of the RSS rise is the
  first hour (39 → 99 MB, then flat); the verdict now warms up for an hour and compares
  medians (ad2c948, fe17b95), and fails a run that slept.

| Round | Wall h | RSS MB | Heap MB |
| ----: | -----: | -----: | ------: |
|    10 |   0.18 |   77.0 |    54.0 |
|    20 |   0.46 |   38.9 |    54.4 |
|    40 |   0.93 |   98.9 |    55.0 |
|    50 |   1.09 |   86.0 |    55.4 |
|    70 |   1.43 |   86.7 |    55.7 |
|    80 |   1.59 |   94.6 |    55.9 |
|   100 |   1.93 |  100.5 |    56.2 |
|   110 |   2.10 |   95.8 |    56.3 |
|   120 |   2.26 |   99.4 |    56.4 |
|   140 |   2.60 |   90.6 |    56.6 |
|   150 |   2.76 |   98.9 |    56.6 |
|   170 |   3.10 |   96.6 |    56.9 |
|   180 |   3.27 |  102.8 |    57.0 |
|   190 |   3.43 |  106.5 |    57.0 |
|   210 |   3.77 |  103.4 |    57.1 |
|   220 |   3.93 |   99.8 |    57.2 |
|   240 |   4.27 |  101.1 |    57.2 |
|   250 |   4.43 |  109.5 |    57.3 |
|   270 |   4.77 |  106.9 |    57.6 |
|   280 |   4.94 |  107.4 |    57.6 |
|   290 |   5.10 |  106.1 |    57.6 |
|   310 |   5.44 |  109.0 |    57.7 |
|   320 |   5.60 |   97.9 |    57.7 |
|   340 |   5.94 |  104.4 |    57.8 |
|   350 |   6.11 |  102.0 |    57.8 |

## 2026-10-31T07:52:12.903Z — FAIL

- Node v24.22.1, darwin/arm64; GC exposed: yes
- Wall time 26.51 h, 84 rounds, one request every 60 s
- Allowed 84/84; duplicate decisions 0; canary leaks 0
- Phone reconnects 8; agent drops 5, agent reconnects 5
- Hook round trip p50 24 ms, p99 117 ms, max 117 ms
- RSS baseline 126.4 MB, growth 0.0 MB (limit 20 MB)
- Verdict: 84 rounds in 26.51 h (1590 expected): the machine slept
- Cause: the Mac ran on battery with the lid closed from about 10:40 on 2026-10-31 until a
  lid wake at 00:42 on 2026-11-01 (`pmset -g log`). `caffeinate -dims` does not prevent
  lid-close sleep on battery. Run 3 needs AC power and the lid open.

| Round | Wall h | RSS MB | Heap MB |
| ----: | -----: | -----: | ------: |
|    10 |   0.17 |  132.4 |    53.7 |
|    20 |   0.33 |  129.7 |    54.1 |
|    30 |   0.74 |  131.7 |    54.5 |
|    40 |  14.87 |  113.5 |    54.7 |
|    50 |  15.04 |  126.4 |    55.1 |
|    60 |  15.21 |  126.4 |    55.2 |
|    70 |  15.37 |  131.7 |    55.4 |
|    80 |  17.54 |  119.8 |    55.5 |
