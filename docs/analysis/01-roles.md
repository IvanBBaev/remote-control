# 01 — Which roles must analyse remote-control, and why

Status: 2026-10-12. Method: start from the components and the risk surface in
`00-brief.md`, then ask for each one "who would be blamed if this part fails in
production?". That person is the role. Each role is dispatched as a separate
senior specialist with the brief as input and writes one report into
`reports/`. The roadmap (`ROADMAP.md`) is synthesised from all reports.

## Risk surface → roles

| # | Role | Owns | Why it is needed here | Report |
|---|------|------|------------------------|--------|
| 1 | **Product & UX strategist** | Scope, positioning, user journeys, what to cut | Claude Code's own Remote Control and Coucou already exist. Without an honest positioning the project builds a worse copy of a built-in feature. Also decides what the MVP phone screens are. | `reports/01-product.md` |
| 2 | **Security architect** | Threat model, E2E encryption, pairing, passkeys, tenant isolation, agent-side authorization | The core feature is remote code execution on a user's computer, triggered over the public internet, in a public repo, for many users. This is the role that decides whether the project is shippable at all. | `reports/02-security.md` |
| 3 | **Backend / distributed-systems architect** | Relay design: WebSocket hub, presence, delivery semantics, Postgres schema, protocol versioning, Railway fit | Three parties (phone, relay, agent) with intermittent connectivity and a blocking permission request in the middle. Ordering, timeouts and reconnection are where this breaks. | `reports/03-backend.md` |
| 4 | **Agent-integration engineer** | Claude Code hooks, Agent SDK vs CLI, session identity, transcripts, Codex / Gemini adapters | Everything depends on what Claude Code actually exposes today. Wrong assumptions here invalidate the whole roadmap. Must verify against current docs. | `reports/04-agent-integration.md` |
| 5 | **PWA / mobile frontend engineer** | PWA on iOS and Android, Web Push, installability, WebAuthn in a PWA, approval UI, state sync, offline | The owner decided PWA over native. iOS has specific limits on push, background and WebAuthn inside installed web apps; the feasibility of "approve from the lock screen" rests here. | `reports/05-pwa.md` |
| 6 | **Platform / DevOps engineer** | Railway deployment, Postgres, environments, CI/CD, agent packaging and daemonisation, updates, observability, cost | A multi-tenant service run by one person: it must deploy itself, keep itself alive and cost ~nothing. The agent must install and stay running on macOS, Windows and Linux. | `reports/06-platform.md` |
| 7 | **QA / test-strategy engineer** | Test pyramid, fakes for Claude Code, E2E tests for the three-party flow, crypto test vectors, CI gates | The system is only testable if a fake Claude Code and a fake phone exist from day one. If this is designed after the code, it never gets done. | `reports/07-qa.md` |

## Roles considered and not dispatched

- **Native iOS / Android engineer** — the owner decided PWA. Revisit only if
  report 05 says push or biometrics are not viable in a PWA.
- **Legal / privacy officer** — the data held by the relay is metadata about
  accounts and devices; GDPR-minimal handling is folded into the security report
  (§ data retention). A dedicated role is overkill for a side project.
- **Visual / brand designer** — the MVP uses a plain, native-feeling component
  set; a designer comes after the flow works.
- **SRE / on-call** — no on-call exists; the platform report must design for
  "nobody is watching" instead.
- **Monorepo / TypeScript architect** — folded into the backend report (package
  layout, shared protocol package, build).

## Rules for every specialist

- Input: `00-brief.md` only, plus whatever you verify on the web or in the
  referenced repositories. Do not assume another specialist's conclusions; where
  your domain touches another's, state the interface you need from them.
- Output: one file, the section order from brief §8, nothing else written to the
  repository.
- Verified facts carry a URL. Unverified claims are listed as assumptions.
- Prefer the smallest design that is sound. This is a side project with one
  developer; a recommendation that needs a team is a wrong recommendation.
