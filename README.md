# remote-control

One inbox for every coding agent on your own machines: approve, answer, instruct and
start sessions from your phone, from anywhere, with your transcripts never stored off
your machines.

> **Status: pre-alpha — nothing to install yet.** Milestone M0 (walking skeleton: allow
> or deny one real Claude Code permission request from the phone) is in progress. The
> protocol, crypto, logging packages, the relay skeleton and the `remotectl` CLI skeleton
> exist; pairing, the WebSocket hub, push and the phone app do not. Everything below
> marked _planned_ is design, not code.

## How it works

```
phone (PWA) ──WSS──▶ relay (Railway) ◀──WSS── remotectl (your machine) ──hooks── Claude Code
      └──────────── end-to-end encrypted (Noise) ────────────┘
```

- **`remotectl`** runs on your machine, receives Claude Code permission requests through
  its hooks on a loopback-only endpoint, and connects outbound to the relay. No inbound
  port.
- **The relay** routes encrypted frames between your paired devices, sends Web Push and
  stores account metadata only. It cannot read requests or forge decisions.
- **The phone** is a PWA with passkey login. Every Allow / Answer / Instruct / Start
  requires a biometric bound to that exact request.

Details and the threat model: [SECURITY.md](SECURITY.md).

## Why not Claude Code's Remote Control?

If you use only Claude Code on a claude.ai Pro or Max plan, **Claude Code's built-in
[Remote Control](https://code.claude.com/docs/en/remote-control) already does most of
this today** and is the better choice. remote-control exists for the cases it does not
cover.

| Need                             | Claude Code Remote Control                                                                                                                                                                   | remote-control                                              |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Approvals and questions on phone | Yes, with push and biometric step-up                                                                                                                                                         | M0 / M1 (_planned_)                                         |
| Live sessions, diffs, follow-ups | Yes, cross-machine session list and diff pane                                                                                                                                                | Thin session view M1, diffs M2 (_planned_)                  |
| "Always allow" from the phone    | Not documented                                                                                                                                                                               | M1 (_planned_)                                              |
| New session in a chosen repo     | Beta via [Projects](https://code.claude.com/docs/en/claude-projects) / [Desktop](https://code.claude.com/docs/en/desktop): Pro/Max, auto mode, Desktop app running, not with Trusted Devices | Any allow-listed repo on any paired machine, M1 (_planned_) |
| Agents other than Claude Code    | No ([Channels](https://code.claude.com/docs/en/channels) permission relay is also Claude-only)                                                                                               | Adapter boundary from day one; Codex M2 (_planned_)         |
| Auth                             | claude.ai Pro / Max / Team / Enterprise only; not API keys, Bedrock, Vertex, Foundry, gateways, ZDR                                                                                          | Any — it only talks to your local agent's hooks             |
| Where the transcript lives       | On Anthropic's servers while connected                                                                                                                                                       | Never leaves your machines; relay sees metadata only        |
| History and cost per project     | Not documented ([cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web) show usage limits only)                                                                             | M2 (_planned_)                                              |
| Maturity                         | Shipped, supported by Anthropic                                                                                                                                                              | Pre-alpha, one maintainer                                   |

Sources: the linked Claude Code docs pages and the
[hooks reference](https://code.claude.com/docs/en/hooks), as summarised in
[the product analysis](docs/analysis/reports/01-product.md) (§2.1–2.3, §4.2). If Remote
Control gains "Always" from the phone and a non-Claude agent, this project stops.

## Repository layout

| Path                        | What                                                                    |
| --------------------------- | ----------------------------------------------------------------------- |
| `apps/agent`                | `remotectl` — home agent and CLI (npm name reserved, not published yet) |
| `apps/relay`                | Fastify relay — see [apps/relay/README.md](apps/relay/README.md)        |
| `apps/web`                  | Phone PWA (_planned_)                                                   |
| `packages/protocol`         | `rc/v1` envelope and message schemas (zod)                              |
| `packages/crypto`           | Noise `KK` / `XXpsk0` over WebCrypto                                    |
| `packages/log`              | pino logger with payload redaction                                      |
| `packages/fake-claude-code` | Test double for Claude Code hooks                                       |
| `packages/test-harness`     | End-to-end journey harness (_planned_)                                  |
| `docs/analysis`             | Analysis corpus and [roadmap](docs/analysis/ROADMAP.md)                 |

## Development

Requirements: Node 22 (see `.nvmrc`), pnpm 11 (via corepack).

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check   # typecheck, lint, format check, tests with coverage, build
```

Running the relay locally: [apps/relay/README.md](apps/relay/README.md).

## Security

Read [SECURITY.md](SECURITY.md) for the guarantees, the non-guarantees and the threat
model. Report vulnerabilities privately via
[GitHub security advisories](https://github.com/IvanBBaev/remote-control/security/advisories/new),
not as public issues.

## License

[MIT](LICENSE)
