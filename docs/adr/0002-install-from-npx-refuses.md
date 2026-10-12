# ADR 0002 — `install` from the npx cache refuses instead of installing globally

Status: accepted (owner, 2026-10-12), M0-24
Deviates from: D22 ("`install` detects an npx cache path and does a global install first")

## Context

launchd keeps the absolute path of the program it runs forever, so the service must not
point into the npx cache, the pnpm dlx cache or the temp directory — those are cleaned
up and the daemon would silently stop starting. D22 asks `install` to detect that case
and run a global install itself first.

Doing that from the agent means spawning `npm` (or `pnpm`) as a child process:

- it widens the argv surface that `scripts/check-argv-policy.mjs` keeps to two exact
  modules with literal argv builders, and makes the agent execute package lifecycle
  scripts on the user's behalf;
- which package manager, which global prefix, and whether it needs `sudo` (system Node)
  or a version-manager shim (nvm, fnm, volta) are host decisions the agent cannot
  make reliably;
- a failed or partial global install leaves the user's environment changed.

## Decision

`remotectl install` detects a non-stable location (npx `_npx`, pnpm `dlx`, temp
directory, or a non-built entry point) and refuses with exit code 1 and the exact
commands to run instead:

    npm install -g remotectl
    remotectl install

`install --dry-run` reports the same problem. Nothing is installed or written.

## Consequences

- One extra command for users who start with `npx remotectl install`; the message makes
  it copy-pasteable.
- The agent spawns only `/bin/launchctl` (and the Claude Code CLI); no package manager.
- If the owner rejects this ADR, M0-24 gets a follow-up that spawns the package manager
  behind the argv gate, and this ADR is marked superseded.
