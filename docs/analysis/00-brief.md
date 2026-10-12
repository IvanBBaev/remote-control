# remote-control — project brief

Status: DRAFT, 2026-10-12. This is the shared input for the specialist analyses in
`reports/`. Everything here is either an owner decision (marked **DECIDED**) or a
hypothesis to be challenged (marked **HYPOTHESIS**). Specialists must say which
of the hypotheses they confirm, change or reject, and why.

## 1. One-liner

A hosted relay, a small agent on the developer's own computer, and a phone PWA, so
a developer can watch, approve and drive AI coding agents (Claude Code first) that
run on their home/office machine — from their phone, from anywhere.

## 2. Origin

Inspired by Coucou (github.com/Louis-CFM/coucou, Swift, 4.9k stars): a Mac notch
companion that reads Claude Code / Codex / Gemini CLI / Cursor sessions through
hooks, shows permission requests and `AskUserQuestion` prompts, lets the user
Allow / Deny, and follows the user to the phone (iPhone via the user's own iCloud
CloudKit; Android via LAN pairing with a QR code and a pinned certificate).

Coucou's limitation, which is the whole reason for this project: the phone only
works next to the computer (same Wi-Fi) or inside one Apple account. remote-control
is the same idea over the public internet, for many users, with the computer at
home and the user anywhere.

## 3. Owner decisions so far (2026-10-12)

- **DECIDED** — A hosted server on **Railway** is the meeting point. The owner
  chose this over Tailscale and Cloudflare Tunnel because the phone must work with
  nothing but a browser and an account.
- **DECIDED** — The phone client is a **PWA** (one app for iPhone and Android,
  installable, Web Push). Native apps are a later option, not a goal.
- **DECIDED** — **Multi-tenant**: users register an account and use their own
  machines and sessions. The owner is user #1, not the only user.
- **DECIDED** — MVP scope (all four, owner's selection):
  1. Approvals: Allow / Deny on permission requests and answering
     `AskUserQuestion` from the phone, with a push notification.
  2. Live sessions: list of sessions per project, the steps (tools used, files
     edited), diffs, and the last turn.
  3. New instruction to a running session, and starting a **new session in a
     chosen repository** from the phone.
  4. Other agents besides Claude Code (Codex, Gemini CLI, ...) — after Claude Code.
- **DECIDED** — Repository: github.com/IvanBBaev/remote-control, **public**.
  Code, docs, commits in English. MIT license (assumed, like the owner's other
  public repos).
- **DECIDED** — Stack family, from the owner's other projects (kiko, agenthropic,
  servicenow-mcp): TypeScript, Node 22, pnpm monorepo, Fastify, zod or TypeBox
  schemas, React + Vite, ports & adapters, `node --test` or vitest, eslint +
  prettier. The specialists may argue for different libraries inside this family,
  not for a different language or runtime.

## 4. Proposed architecture (HYPOTHESIS)

```
 Phone (PWA) ──HTTPS / WSS──▶  Railway: relay  ◀──WSS, outbound only──  Home computer: agent
                              - accounts, passkeys                     - receives Claude Code hooks
                              - device pairing                           on localhost
                              - WebSocket hub per user                 - holds a permission request
                              - Web Push                                 until the phone decides
                              - serves the PWA                         - starts new sessions in
                              - Postgres (metadata only)                 allow-listed repositories
                                                                       - adapters: Claude Code, Codex, ...
```

- `apps/relay` (Fastify, Postgres), `apps/agent` (Node daemon, published to npm,
  run with `npx`), `apps/web` (React/Vite PWA), `packages/protocol` (shared
  message schemas, versioned).
- The agent connects **outbound** to the relay. No inbound port at home, no
  tunnel, no VPN.
- Claude Code integration through **hooks** configured in the user's
  `~/.claude/settings.json`, pointing at the agent on localhost:
  `PermissionRequest` (blocking, waits for the phone's decision), `Notification`,
  `PostToolUse`, `Stop`, `SessionStart`, `UserPromptSubmit`. The exact hook set
  and their payloads must be verified against the current Claude Code docs.
- Starting a new session or sending an instruction to a running one: either the
  **Claude Agent SDK** (agent spawns a programmatic session) or driving the
  interactive `claude` CLI (tmux / pty). Open question — see §7.
- **End-to-end encryption** phone ↔ agent. The relay forwards opaque payloads and
  sees only metadata (who, which device, online/offline, timestamps). Devices are
  paired with a QR code / short code; keys are per device.
- **WebAuthn / passkeys** for account login, and a fresh user-verifying assertion
  for every Allow and every new session (Face ID / fingerprint).
- **Project allow-list** on the agent: it only works inside explicitly allowed
  directories; nothing from the relay can make it run outside them.

## 5. Prior art and overlaps the specialists must take into account

- **Claude Code's built-in Remote Control** (continue a local session from
  claude.ai/code or the Claude mobile app). What it covers and what it leaves
  out must be verified from current documentation — the product analysis must
  position remote-control against it honestly. If it already does most of the
  MVP, say so.
- **Coucou** — the UX reference. Its iPhone and Android docs (`docs/IPHONE.md`,
  `android/README.md` in that repo) describe a working approval flow with
  biometrics; reuse what is good, do not copy code.
- **agenthropic** (the owner's own project, github.com/IvanBBaev/agenthropic): a
  local-first dashboard over Claude Code transcripts. Its security model
  **deliberately refused a browser-driven `claude` spawner as remote code
  execution** and binds to loopback only. remote-control's core feature *is*
  remote spawning over the internet. The security analysis must take this head-on
  rather than wave at it.

## 6. Constraints

- One developer (the owner) plus AI agents executing the work (Claude Opus 5.5
  will implement the roadmap). Side project; public repo; no team, no on-call.
- Infrastructure cost close to zero: one Railway service + Postgres, free or
  hobby tier at first.
- The home agent must **never** execute an arbitrary command because the relay
  said so. Every action that touches the user's machine must be bound to a
  decision the user made on a paired, authenticated device.
- The owner's work rules: everything in the codebase in English; no AI
  attribution in git history; one commit per finished item; typecheck / lint /
  tests green before a commit.

## 7. Open questions (each specialist answers the ones in their domain)

1. Which Claude Code hooks exist today, which are blocking, what are their exact
   payloads, and can a hook reliably hold a permission request for minutes?
2. Claude Agent SDK vs driving the interactive CLI — which one can (a) start a
   session in a directory, (b) send a follow-up instruction to a running session,
   (c) expose permission requests and `AskUserQuestion` to our code? What does
   each cost in tokens / subscription terms (SDK uses API billing; the CLI uses
   the user's subscription)?
3. How much of the MVP does Claude Code's own Remote Control already cover?
4. Can a PWA on iOS receive Web Push and open on an approval today? Is WebAuthn
   usable inside an installed PWA on iOS and Android?
5. What is the minimal E2E design that is actually sound: key exchange at
   pairing, per-message encryption, relay-side replay protection, key rotation,
   losing the phone, adding a second phone?
6. What must the relay store, and what must it refuse to store, for the
   "relay sees only metadata" promise to hold?
7. Delivery semantics relay ↔ agent: what happens when the agent is offline while
   Claude Code asks for permission; when the phone is offline; when both
   reconnect — ordering, deduplication, timeouts, the hook's own timeout.
8. Codex and Gemini CLI: do they have equivalent hook / approval mechanisms, or
   only a transcript to tail?
9. How is the agent distributed, kept running (launchd / systemd / Windows
   service), and updated?
10. How is any of this tested without a real Claude Code in CI?

## 8. What every report must contain

Markdown, English, under ~600 lines, written for a senior engineer who will
execute, not for the owner's reassurance. Mandatory sections, in this order:

1. **Summary** — 10 lines max, the decisions you recommend.
2. **Verified facts** — things you checked against current documentation or
   source, each with its URL. Anything you could not verify goes to §3 as an
   assumption, never presented as fact.
3. **Assumptions** — explicitly listed.
4. **Findings** — your analysis of the brief's hypotheses in your domain:
   confirm / change / reject, with reasons.
5. **Recommendations** — concrete design decisions, each with the alternatives
   considered and why they lost.
6. **Risks** — with likelihood, impact, and the mitigation you propose.
7. **Work items** — a numbered list of implementable tasks in your domain, each
   with a size (S ≤ half a day, M ≤ 2 days, L ≤ a week of a senior engineer),
   its dependencies, and an acceptance criterion a machine or a reviewer can
   check.
8. **Open questions for the owner** — only things that genuinely need the owner's
   decision; propose a default for each.
9. **Sources** — URLs consulted.
