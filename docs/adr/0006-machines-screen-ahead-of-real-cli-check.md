# ADR 0006 — Machines screen and self-test ahead of the real-CLI check

Status: accepted (owner, 2026-10-13), M1-07
Deviates from: ROADMAP §4 dependency order (M1-07 depends on M1-05, which is
`doing — code done; real-CLI check pending M0-23`, ADR 0005)

## Context

M1-07 (`/machines`, the "Can't connect?" checklist, `remotectl status --self-test`)
depends on M1-05. The code of M1-05 is done; only its real-CLI check is pending, and that
check waits on M0-23 (deployed relay, real device, §6 Q2). Nothing in M1-07 calls the
`claude` CLI: it reads what the agent already has (paired phones, the allow-list, the
hooks settings, the hooks that arrived) and sends one request through the existing hook
path.

The owner chose to build M1-07 now, in the same way as ADR 0005.

## Decision

- Build M1-07 now, as code, unit and screen tests, and a harness journey:
  - **Shared wording.** `packages/protocol/src/setup-checklist.ts` holds the four checks
    (agent running, relay reachable, hooks installed, repository trusted), each with a
    question and a fix, plus the per-repository hook strings. `remotectl status` and the
    phone's "Can't connect?" list render the same strings.
  - **Snapshot fields.** `devices` (id, name, paired date; never a key), `hooksInstalled`,
    and `hookSeen` on each repository. All three are optional, so an older phone or agent
    ignores them.
  - **Hook seen.** The agent records the first hook from each allow-listed root in
    `hooks-seen.json` in the data directory (0600, root path and time only, never sent
    to the relay except inside the E2E snapshot). Claude Code runs hooks only in trusted
    folders (04 §2.6), so a root with a hook is a trusted root.
  - **Health probes.** The hook receiver answers an authenticated `GET /health` with
    204, so `status` can tell a running agent from a stale `agent.json`. The relay's
    public `GET /health` is probed outside `/api`, and only when the agent is logged in.
  - **Self-test.** `remotectl status --self-test` runs the `hook.cjs` logic in process
    with a synthetic `PermissionRequest` (session id `remotectl-self-test`,
    `echo "remotectl self-test"`, cwd the data directory) and a 130 s hook timeout. It
    reports the phone's answer. Nothing runs whatever the answer: the command is not a
    Claude Code session and ignores the decision. The agent does not add the self-test
    to the session registry, the feed, the counters or the hook-seen record. A paused or
    stopped agent fails the self-test at once with the fix.
- **Revoke.** The paired-device list shows a disabled "Revoke" entry point. Revocation
  itself is M1-10.
- **Presence.** "Last seen" on `/machines` keeps the existing relay-timestamp presence.
- The WP status stays `doing — code done; real-CLI check pending M0-23 (ADR 0006)` until
  M1-05 is done. The real-CLI check then covers one thing: that a real Claude Code
  install in a trusted folder fills `hooks-seen.json`, and an untrusted one does not.

## Consequences

- M1-10 (revocation) can build on the device list in the snapshot.
- If M0-23 shows that Claude Code runs hooks in untrusted folders too, "hook seen" stops
  meaning "trusted". The check is then renamed to "hooks seen from the repository"; the
  wording lives in one file.
- The self-test cannot tell a phone's deny from the agent's own deadline deny
  (`agent.onExpire: "deny"`) except by its message. It treats the agent's deny as no
  answer.
