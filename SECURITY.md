# Security

remote-control lets a phone approve, answer and start AI coding agent sessions on your
own machines through a hosted relay. Its security rests on one rule: **the remote path
adds no capability you do not already have at the keyboard, and nothing happens without
your fresh, verified consent on a paired phone.**

> **Status: pre-alpha.** This document describes the design the code is being built to
> (milestone M0 in progress). Parts marked _planned_ are not implemented yet. Do not rely
> on this software to protect anything until a release says otherwise.

## Reporting a vulnerability

Report privately through GitHub:
[Security → Report a vulnerability](https://github.com/IvanBBaev/remote-control/security/advisories/new).
Do not open a public issue for a security problem.

This is a one-person project; expect an acknowledgement within a week. There is no bug
bounty. Only the latest commit on `main` (and, once published, the latest `remotectl`
release) is supported.

## Components and trust boundaries

| Component                        | Holds                                       | Trusted for                                  |
| -------------------------------- | ------------------------------------------- | -------------------------------------------- |
| Phone (PWA browser profile)      | Device key, passkey                         | Making decisions (with a biometric)          |
| Relay (hosted on Railway)        | Account metadata, routing, presence         | Authenticating accounts, not actions         |
| Agent `remotectl` (your machine) | Device keys, project allow-list, spawn argv | Acting only on authenticated phone decisions |
| Claude Code                      | Your user permissions                       | Whatever it can already do locally           |

## Guarantees (design conditions)

1. **Authority never originates at the relay.** The agent acts on a message only if it
   decrypts and authenticates under a Noise `KK` session with a paired phone. A relay
   operator, another tenant or a TLS man-in-the-middle can delay, drop or replay bytes;
   the agent acts on none of them. The relay can only shrink trust (revoke, disconnect),
   never add it.
2. **Every machine-touching action carries a user-verified WebAuthn assertion bound to
   that exact request.** Allow, Always, Answer, Instruct and Start require a biometric
   whose challenge is the hash of the canonical decision. Deny, stop and read-only views
   do not.
3. **Spawning is a fixed argv.** The protocol has no permission-mode field;
   `--dangerously-skip-permissions`, `bypassPermissions`, `--allowedTools` and
   `--settings` are never emitted. A CI gate (`apps/agent/scripts/check-argv-policy.mjs`)
   enforces that only the spawn module imports `child_process`.
4. **The project allow-list and relay URL are local config**, not protocol fields, and
   cannot be changed from the phone. Paths are resolved with `realpath` and must lie
   inside an allow-listed root.
5. **The agent has no inbound network surface.** Its hook endpoint binds to `127.0.0.1`
   only, requires a per-install token and has no "decide" API; decisions arrive only over
   the agent's outbound WebSocket session.

Invariants that hold in every release:

- **I1** — Nothing runs on your machine because the relay said so.
- **I2** — The agent never leaves Claude Code hanging: an undecidable request is released
  or denied before Claude Code's hook timeout; an undeliverable decision is dropped,
  never queued.
- **I3** — The relay sees metadata only: no message bodies, no transcripts, no push
  content it can read, no log line with a payload.
- **I4** — The agent is installed from one `npx` command and never auto-updates its own
  code.

## What this does not protect against

A prompt-injected or malicious Claude Code session already runs with the user's full
permissions. It can read the agent's key file, edit `~/.claude/settings.json`, or kill
the agent. **remote-control does not make the machine safer than Claude Code alone; it
guarantees that the remote path adds no new capability.** The one escalation it blocks is
self-approval: no loopback API can approve anything, and the hook endpoint only creates
phone prompts.

Recommended hardening (a ready-made snippet is _planned_): `permissions.deny` for `Read`
and `Edit` of the agent's config and data directories and of `~/.claude/settings.json`,
`disableBypassPermissionsMode: "disable"`, and a `ConfigChange` hook that blocks changes
while a remote session is active.

## Threat model

Assets: the ability to execute on your machine; permission-request content (commands,
paths, diffs, prompts — often secrets); account and device identity; availability of the
approval path.

| Actor                                       | Can                                                            | Cannot (by design)                                                                       |
| ------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Malicious relay operator / compromised host | See metadata, drop, delay, replay, revoke, send fake push, DoS | Read content, forge a decision, start a session, add a device, change the allow-list     |
| Other tenant                                | Hit public endpoints, create accounts (invite code required)   | Route to your devices (routing is keyed by the authenticated socket's user)              |
| Stolen phone, locked                        | Nothing                                                        | —                                                                                        |
| Stolen phone, unlocked                      | View sessions, Deny, Stop                                      | Allow, answer, instruct or start without the biometric                                   |
| Stolen session cookie                       | Call the relay API as you                                      | Decrypt anything or approve anything (no device key, no biometric)                       |
| Attacker on your LAN                        | Nothing: no inbound port, hook endpoint is loopback-only       | —                                                                                        |
| npm supply chain (agent dependencies)       | Full compromise if a malicious version is installed            | Mitigated, not prevented (see Supply chain)                                              |
| Prompt-injected Claude Code session         | Everything you can do locally                                  | Approve its own request remotely                                                         |
| Lost machine                                | Holds the agent key and relay token                            | Keep access once you revoke the device from the phone (the relay deletes the token hash) |

Until agent-side assertion verification ships (_planned_, milestone M2), the relay
verifies the WebAuthn assertion and the agent checks the decision binding (session,
pending request, request hash, expiry, peer). A compromised relay could therefore skip
the biometric check, but still cannot forge a decision without a paired phone's session
keys.

## What the relay sees and stores

**Sees in plaintext:** your user id (from the authenticated socket), sender and recipient
device ids, message kind, session id, counter, byte length, timestamps, and the WebAuthn
assertion beside a decision envelope. Push payloads are composed by the relay and carry
metadata (envelope id, device, expiry) plus, when the agent sent one, a notification
summary (project, tool label or turn-notice label, one secret-masked line; a finished
turn carries no line, since the last assistant message may quote files) that the agent
sealed with a
per-pairing key the relay never holds; the relay copies those bytes and cannot read them
(ADR 0001).

**Stores (Postgres):** users (random handle), passkey public keys, one hashed recovery
code, devices (kind, name, created / last seen / revoked), pairings, push subscriptions,
session hashes, agent token hashes, short-lived pairing slots, and an audit log (event,
user, device, timestamp — no bodies). Request logs with IPs are kept 14 days, audit
events 90 days.

**Never stores:** message bodies, transcripts, permission-request content, decisions'
payloads, e-mail addresses, names, or any queued message — there is no message table and
no store-and-forward; a frame the recipient cannot receive is dropped. Presence lives in
memory. Logs redact tokens, cookies, payloads, ciphertext, push endpoints, WebAuthn
challenges and pairing codes.

## Cryptography

- Phone ↔ agent sessions: `Noise_KK_25519_AESGCM_SHA256`, re-handshake on every
  reconnect, strict counters, header bound as AAD so the relay cannot re-address frames,
  padded frames.
- Pairing: `Noise_XXpsk0_25519_AESGCM_SHA256`; the PSK comes from a one-time code the
  relay never sees, in a single-use five-minute slot with fingerprint confirmation on
  both ends.
- All primitives via WebCrypto in Node 22 and the browser (iOS 17+, Chrome Android 133+).
- Accounts: passkeys only, no e-mail, `__Host-` session cookie `SameSite=Strict`.

## Supply chain

- `remotectl` is published as one bundled file with **zero runtime dependencies** and no
  install scripts; the `files` whitelist ships only `dist/`. A test checks the packed
  file list.
- Releases are published only by npm trusted publishing from a tagged GitHub Actions run
  with provenance (_planned_ with the first release). Verify an install with
  `npm audit signatures`.
- The repo installs with a frozen lockfile and pnpm `minimumReleaseAge` of 7 days, so a
  freshly published (possibly compromised) dependency version is never picked up.
- The agent never updates itself; it may tell you a newer version exists, and you run
  `remotectl update` yourself.
