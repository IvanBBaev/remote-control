# v2.0 analysis — brief

Status: 2026-10-24. Scope of this corpus: what remote-control **2.0** should be, after
the v1 roadmap (M0–M4, `docs/analysis/ROADMAP.md`) ships. Nothing here is a decision;
decisions are made in a v2 roadmap synthesised from the reports, ratified by the owner.

## Where v1 stands (read, do not re-analyse)
- `docs/analysis/ROADMAP.md` (§1 product, §2 decisions D1–D25, §3 milestones, §6 owner
  questions, §7 risks), `docs/adr/0001…0017`, `docs/product/screens.md`.
- Built: relay (Fastify/Postgres, E2E payloads, metadata only), `remotectl` agent,
  PWA, Claude Code + Codex + Gemini (observe/deny) + claude-sdk adapters, diff viewer,
  agent-side assertion check, PgNotify 2-replica hub, staging, native Expo app with
  Live Activities and widgets (M4 in progress).
- Invariants I1–I4 (ROADMAP §1) are binding for 2.0 unless an analysis argues, with an
  ADR-shaped proposal, that one must change.
- v1 is single-owner plus a named second user. Real-device, real-CLI and domain/deploy
  gates are still open.

## Question for 2.0
v1 answers "approve my agents from my phone". What would make a 2.0 worth a major
version? Candidate themes (analysts may add, merge or reject them):
1. Teams / multiple humans per machine, delegation, audit trail, policy (allow-lists
   managed centrally, quorum approvals).
2. Agent breadth: more agents, agent-to-agent/fleet view, long-running/autonomous jobs,
   scheduling, cost/budget guardrails.
3. Smarter approvals: risk scoring, auto-allow rules learned from history, batch
   approvals, summaries — without breaking I1/I3.
4. Distribution: Android native, desktop/watch clients, App Store/TestFlight release,
   self-host option, pricing/hosting model.
5. Relay at scale: more than 2 replicas, regions, cost per user, abuse limits.
6. Competitive reality: Anthropic Remote Control, Coucou and others keep moving; the v1
   kill criterion (ROADMAP §1) needs a v2 counterpart.

## Rules for every analyst
- Verify against current docs/sources on the web; every verified fact carries a URL,
  everything else is an assumption.
- Smallest sound design; one developer plus an AI executor.
- Output exactly one file, `docs/analysis/v2/reports/<NN>-<role>.md`, English, under
  ~500 lines, sections in this order: Summary (≤10 lines) · Verified facts · Assumptions ·
  Findings · Recommendations (with rejected alternatives) · Risks · Work items (size,
  deps, machine-checkable AC) · Open questions for the owner (with defaults) · Sources.
- Do not modify any other file. Do not commit.
