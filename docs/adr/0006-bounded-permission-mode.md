# ADR 0006 — Bounded `--permission-mode` for phone-started sessions

Status: accepted, M2-09
Amends: D11 ("no `--permission-mode` from the phone in MVP"), D13 (forbidden tokens of
the argv gate), 02 §4.1(3) and SECURITY.md point 3 ("the protocol has no
permission-mode field")

## Context

M2-09 (04 W10, 04 §5.4) lets the phone start a session in a permission mode other than
the default one, capped per repository in the agent config. D11 kept the start argv to
the literal `["--bg", "--name", name, prompt]` and left `--permission-mode` out of the
MVP. D13's gate forbids permission tokens anywhere in agent source. M2-09 needs a
narrow exception to both.

## Decision

- **The ladder.** The modes are `plan < default < acceptEdits`. `bypassPermissions`,
  `dontAsk` and any other mode are not in the protocol, the config or the argv module.
  `dontAsk` joins the gate's forbidden tokens.
- **The bound is local config.** Each `repositories` entry in the agent config is
  either a bare root (bound `default`) or `{ "path": root, "maxPermissionMode": mode }`.
  As with the allow-list (D13, Q17), no protocol message can change it. The snapshot
  shows each repository's bound so the phone can offer only the modes at or below it.
- **The phone picks, the agent decides.** `StartSession.permissionMode` is optional.
  The phone never sends `default`; it sends nothing instead, so an agent before M2-09
  reads the same start it always did. A present mode is part of the signed start hash:
  `requestHash({ prompt, cwd, permissionMode })` covers
  `{prompt, cwd, permission_mode}`, and a start without a mode hashes exactly as in
  M1-04. The agent
  checks the mode against the folder's bound after the allow-list check and before any
  spawn. A missing mode counts as `default`, so a `plan`-bound folder refuses it too.
  A refusal is the existing `not_allowed` rejection; the audit log says
  `permission_mode_above_bound`.
- **The argv.** `default` keeps the M1-04 argv unchanged. `plan` and `acceptEdits` use
  `startSessionInModeArgv`:
  `["--bg", "--permission-mode", mode, "--name", name, prompt]`. The builder checks the
  mode again and refuses anything except those two.
- **The gate exception.** `--permission-mode` may appear in exactly one place: once, as
  a string literal element of the array an `...Argv` builder in
  `adapters/claude-code/spawn.ts` returns. A second occurrence anywhere in that file,
  even in a comment, fails the gate, and so does any occurrence in another module.
  `spawnBackgroundSession` may pick between two `...Argv` builders with a conditional;
  both branches must be builder calls.

## Consequences

- A phone holding a valid passkey can start a session that edits files without asking
  only in a folder whose owner set `acceptEdits` locally. Every tool call still goes
  through the hooks; `acceptEdits` only skips the file-edit prompts.
- The real-CLI check of M0-23 also covers `--bg --permission-mode <mode>`.
