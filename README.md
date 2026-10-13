# remote-control

One inbox for every coding agent on your own machines: approve, answer, instruct and
start sessions from your phone, from anywhere, with your transcripts never stored off
your machines.

> **Status: pre-release.** The M1 feature set is built and tested end to end against a
> fake Claude Code (journeys J1–J12, Playwright P1–P9). Not done yet: the public relay
> deployment, the runs on real iPhone / Android phones and with the real `claude` CLI,
> and the first npm release `remotectl@0.1.0`. Until then, build from source
> (Development below).

## How it works

```
phone (PWA) ──WSS──▶ relay (Railway) ◀──WSS── remotectl (your machine) ──hooks── Claude Code / Codex
      └──────────── end-to-end encrypted (Noise) ────────────┘
```

- **`remotectl`** runs on your machine, receives permission requests through the agent's
  hooks on a loopback-only endpoint, and connects outbound to the relay. No inbound port.
- **The relay** routes encrypted frames between your paired devices, sends Web Push and
  stores account metadata only. It cannot read requests or forge decisions: the computer
  checks the passkey signature on every Allow itself.
- **The phone** is a PWA with passkey login. Every Allow / Always / Answer / Instruct /
  Start requires a biometric bound to that exact request. Deny and "Reply in terminal"
  do not.

Details and the threat model: [SECURITY.md](SECURITY.md).

## Why not Claude Code's Remote Control?

If you use only Claude Code on a claude.ai Pro or Max plan, **Claude Code's built-in
[Remote Control](https://code.claude.com/docs/en/remote-control) already does most of
this today** and is the better choice. remote-control exists for the cases it does not
cover.

| Need                             | Claude Code Remote Control                                                                                                                                                                   | remote-control                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Approvals and questions on phone | Yes, with push and biometric step-up                                                                                                                                                         | Yes: push, approval card, `AskUserQuestion`, "Reply in terminal"                                   |
| Live sessions, diffs, follow-ups | Yes, cross-machine session list and diff pane                                                                                                                                                | Thin live view, diffs fetched on demand, follow-ups to sessions started from the phone             |
| "Always allow" from the phone    | Not documented                                                                                                                                                                               | Yes: this session by default; project settings only if the computer's config allows it             |
| New session in a chosen repo     | Beta via [Projects](https://code.claude.com/docs/en/claude-projects) / [Desktop](https://code.claude.com/docs/en/desktop): Pro/Max, auto mode, Desktop app running, not with Trusted Devices | Any allow-listed folder on any paired computer, permission mode bounded per folder                 |
| Agents other than Claude Code    | No ([Channels](https://code.claude.com/docs/en/channels) permission relay is also Claude-only)                                                                                               | Codex CLI approvals (no questions or follow-ups yet)                                               |
| Auth                             | claude.ai Pro / Max / Team / Enterprise only; not API keys, Bedrock, Vertex, Foundry, gateways, ZDR                                                                                          | Any — it only talks to your local agent's hooks                                                    |
| Where the transcript lives       | On Anthropic's servers while connected                                                                                                                                                       | Never leaves your machines; relay sees metadata only                                               |
| History and cost per project     | Not documented ([cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web) show usage limits only)                                                                             | Sessions, tool calls, active time, approvals per repository (kept on the computer); no token costs |
| Maturity                         | Shipped, supported by Anthropic                                                                                                                                                              | Pre-release, one maintainer                                                                        |

Sources: the linked Claude Code docs pages and the
[hooks reference](https://code.claude.com/docs/en/hooks), as summarised in
[the product analysis](docs/analysis/reports/01-product.md) (§2.1–2.3, §4.2). If Remote
Control gains "Always" from the phone and a non-Claude agent, this project stops.

## Quick start

> Not published yet: the first public version is **`remotectl@0.1.0`**. The commands
> below are the intended flow; from source, run `pnpm build` and use
> `node apps/agent/dist/cli.mjs` in place of `remotectl`. Setting up takes about ten
> minutes.

You need an invite code from the relay operator, a phone with a passkey (Face ID, Touch
ID or a screen lock) and, on the computer, Node 22 or later.

**1. On the phone** — open the invite link, then follow the app:

1. **Create passkey**, and save the recovery code it shows once.
2. **Install the app** (Add to Home Screen; on iPhone this is required for notifications)
   and open it from the icon.
3. **Turn on notifications.**
4. **Add a computer**: name it, and the app shows a one-time `remotectl login …` command.

**2. On the computer** that runs your coding agent:

```sh
npm install -g remotectl@0.1.0
remotectl status            # prints the config file path
```

Put the relay address and the folders the phone may work in into that config file
(`config.json`; the folders are the allow-list, editable only here):

```json
{
  "relay": { "url": "wss://<relay host>" },
  "repositories": ["/Users/you/code/my-project"]
}
```

Then:

```sh
remotectl login rc-enroll:…   # the command the phone showed
remotectl hooks install       # Claude Code hooks; add --agent codex for Codex CLI
remotectl install             # runs the agent as a login service (launchd, systemd --user, Task Scheduler)
remotectl pair                # prints a QR code and a 12-character code
```

**3. Back on the phone** — scan the QR code or type the code, check that both screens show
the same fingerprint, and tap **The codes match**.

**4. Check it end to end:**

```sh
remotectl status --self-test  # sends a test request; approve it on the phone
```

Claude Code runs hooks only in folders you trusted, so open each allow-listed folder in
Claude Code once. `remotectl status` and the phone's **Can't connect?** list show which
check fails and how to fix it.

Install it globally, not through `npx`: the service must point at a stable path
([ADR 0002](docs/adr/0002-install-from-npx-refuses.md)). Every release is published from
GitHub Actions with npm provenance; check it with `npm audit signatures`. How releases are
cut: [docs/release-checklist.md](docs/release-checklist.md).

## Everyday use

| Command                         | What it does                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `remotectl status`              | Config, allowed folders, keys, hooks, the setup checklist and the local counters |
| `remotectl pause [--for 2h]`    | Hand every request straight back to the terminal; nothing reaches the phones     |
| `remotectl resume`              | End a pause                                                                      |
| `remotectl devices`             | List paired phones                                                               |
| `remotectl devices revoke <id>` | Unpair a phone; it must pair again                                               |
| `remotectl logs [-f]`           | Print (or follow) the agent log                                                  |
| `remotectl update`              | Check npm for a newer version (never installs it)                                |
| `remotectl uninstall`           | Remove the login service; `remotectl hooks remove` removes the hooks             |
| `remotectl run`                 | Run the agent in the foreground instead of as a service                          |

Optional settings in `config.json`:

| Key                                         | Default       | Effect                                                                                  |
| ------------------------------------------- | ------------- | --------------------------------------------------------------------------------------- |
| `repositories[].maxPermissionMode`          | `"default"`   | Highest mode the phone may start a session in: `plan`, `default` or `acceptEdits`       |
| `always.destinations`                       | `["session"]` | Add `localSettings` / `projectSettings` to let "Always" write to Claude Code's settings |
| `hooks.holdSeconds`                         | `1800`        | How long a request waits for the phone before the terminal takes over                   |
| `agent.onExpire`                            | `"handoff"`   | At that deadline: hand back to the terminal, or `"deny"`                                |
| `notifications.turnFinished` / `needsInput` | `false`       | Also push when a turn ends / the agent waits for input                                  |

A folder is written as a plain path or as `{ "path": "…", "maxPermissionMode": "plan" }`.

On the phone, **Computers** lists each paired computer with its setup checks, history
per repository and paired phones (each with **Revoke**), and **Delete account**, which
removes the account and everything the relay keeps about it. The screens and their
states are described in [docs/product/screens.md](docs/product/screens.md).

## Repository layout

| Path                        | What                                                                            |
| --------------------------- | ------------------------------------------------------------------------------- |
| `apps/agent`                | `remotectl` — home agent and CLI, [published to npm](docs/release-checklist.md) |
| `apps/relay`                | Fastify relay — see [apps/relay/README.md](apps/relay/README.md)                |
| `apps/web`                  | Phone PWA (React, Vite)                                                         |
| `packages/protocol`         | `rc/v1` envelope and message schemas (zod)                                      |
| `packages/crypto`           | Noise `KK` / `XXpsk0` over WebCrypto                                            |
| `packages/log`              | pino logger with payload redaction                                              |
| `packages/fake-claude-code` | Test double for Claude Code and Codex hooks                                     |
| `packages/test-harness`     | End-to-end journeys (J1–J12) and the privacy gate                               |
| `e2e`                       | Playwright specs for the PWA                                                    |
| `docs`                      | [Roadmap](docs/analysis/ROADMAP.md), ADRs, screens, verification logs, runbook  |

## Development

Requirements: Node 22 (see `.nvmrc`), pnpm 11 (via corepack).

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check      # typecheck, lint, format check, tests with coverage, build
pnpm test:e2e   # Playwright against the built PWA and a local relay
```

Running the relay locally: [apps/relay/README.md](apps/relay/README.md).

## Security

Read [SECURITY.md](SECURITY.md) for the guarantees, the non-guarantees and the threat
model. Report vulnerabilities privately via
[GitHub security advisories](https://github.com/IvanBBaev/remote-control/security/advisories/new),
not as public issues.

## License

[MIT](LICENSE)
