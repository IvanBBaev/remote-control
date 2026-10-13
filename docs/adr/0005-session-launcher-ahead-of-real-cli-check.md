# ADR 0005 — Session launcher ahead of the real-CLI check

Status: accepted (owner, 2026-10-13), M1-04
Deviates from: ROADMAP §4 dependency order (M1-04 depends on M0-23)

## Context

M1-04 (session registry, launcher, follow-up, journeys J9–J11) depends on M0-23, the
check that a real Claude Code CLI accepts a decision made on the phone. M0-23 needs the
deployed relay and a real device, and it waits on the domain (§6 Q2). M0-22 (the
harness) is done, and `fake-claude` already models the CLI surface M1-04 uses:
`--bg --name`, `--resume <uuid> --bg`, `agents --json --all`, `--version` and workspace
trust (04 §2.8).

The owner chose to write M1-04 now against `fake-claude` and to run the real-CLI check
when M0-23 can run.

## Decision

- Build M1-04 now as code, unit tests and harness journeys against `fake-claude`:
  - the session registry (hooks plus a roster poll every 10 s while sessions exist,
    dropped after 24 h);
  - the launcher (allow-list re-resolved at every launch, a trust warning for a folder
    no hook came from, the literal argv of the spawn module, UUID capture by
    `name + cwd`);
  - follow-ups through `--resume <uuid> --bg` for background sessions only, behind the
    `--version` ≥ 2.1.257 gate;
  - the protocol additions: `start` and `instruct` messages with a signed
    `start` / `instruct` decision. Both need a user-verifying assertion (D7). Their
    `request_hash` is `requestHash({ prompt, cwd })` and `requestHash({ prompt,
sessionId })`. There are new rejection reasons (`not_allowed`, `start_failed`,
    `follow_up_unsupported`), plus `repositories`, `name` and `followUp` in the
    snapshot.
- The WP status stays `doing — code done; real-CLI check pending M0-23` until M0-23
  runs. The real-CLI check then covers four things: the roster fields, the
  `--resume --bg` session id, the trust behaviour and the exit code of `--bg`. Any
  difference becomes a change to the spawn module and to `fake-claude`.
- **Symlink AC.** "Symlink into the allow-list refused" is read as: no symlink can lead
  a launch outside the allow-list. The phone never sends a path, only a repository id
  the agent offered. The agent resolves that root with `realpath` at launch time and
  spawns `claude` in the canonical path, so a symlink cannot redirect a launch. A
  symlink inside a root that points outside it is refused. A follow-up re-resolves the
  session's folder the same way. A root that is itself a symlink is judged by where it
  points at launch time (`resolveRepository`, M0-era behaviour, unchanged).
- **Windows.** The agent spawns `claude` without a shell (D13). On Windows the npm
  install of Claude Code is a `claude.cmd`, which `spawn` without a shell cannot run.
  The spawn tests and journeys J9–J11 skip on Windows. Resolving the native
  `claude.exe` (or refusing clearly) is part of the M0-23 real-CLI check.
- **Fake session lifetime.** `fake-claude --bg` plays the session inline and exits when
  it ends, so a started session is already `done` in the roster when the agent reads
  it. J10 therefore accepts a `start` without a session id. J9 seeds a live background
  session in the roster to send the follow-up to.

## Consequences

- M1-05 (live feed) can build on the registry and the snapshot fields now.
- If M0-23 finds that the real CLI differs (flags, roster shape, trust prompt in `--bg`),
  the launcher and `fake-claude` change together. The protocol messages and the D7
  checks do not depend on the CLI.
- Until M0-23, nothing on a real machine has started a session from the phone. The
  owner should not rely on the feature before then.
