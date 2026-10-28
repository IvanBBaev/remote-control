# v3.0 analysis — brief

Status: 2026-10-28. Scope of this corpus: what remote-control **3.0** should be, after
v1 (M0–M4, `docs/analysis/ROADMAP.md`) and the v2.0 draft (`docs/analysis/v2/`) ship.
Nothing here is a decision; decisions are made in a v3 roadmap synthesised from the
reports, ratified by the owner.

## Where the project stands (read, do not re-analyse)
- v1: `docs/analysis/ROADMAP.md` (§1 product, §2 decisions D1–D25, §3 milestones, §6
  owner questions, §7 risks), `docs/adr/0001…0017`, `docs/product/screens.md`.
  Built: relay (Fastify/Postgres, E2E payloads, metadata only), `remotectl` agent, PWA,
  Claude Code + Codex + Gemini (observe/deny) + claude-sdk adapters, diff viewer,
  agent-side assertion check, PgNotify 2-replica hub, staging, native Expo app (Secure
  Enclave signing key, APNs actionable notifications, widgets; Live Activity and
  TestFlight still open). Real-device, real-CLI and domain/deploy gates are still open.
- v2 draft: `docs/analysis/v2/SYNTHESIS.md` and `ROADMAP-v2.md` (short; read both), the
  four reports only by section. v2 = teams-lite (principals, roles, monotone signed
  policy, delegation, quorum, hash-chained audit), deterministic smart approvals (batch,
  risk labels, rule proposals), adapter port split + fleet view + guardrails, cells-based
  scaling, TestFlight → App Store, competitive watch with K1–K5.
- v2 explicitly deferred: standing auto-allow rules (needs an ADR amending I1), native
  Android, watch/desktop clients, self-host relay + push gateway, Gemini/Antigravity
  work, relay-side scheduling, LLM scoring, hardware attestation.
- v2 has a cut line: without team demand (V2-P02) it ships as 1.x minors, no "2.0"
  label. **3.0 must be analysed for both branches**: (A) v2 shipped as drafted,
  (B) v2 collapsed into 1.x and teams never happened.
- Invariants I1–I4 (ROADMAP §1) are binding for 3.0 unless an analysis argues, with an
  ADR-shaped proposal, that one must change.

## Question for 3.0
v1 = "approve my agents from my phone". v2 = "verified approvals for small teams and
for agents the vendor's phone app does not reach". What would make a 3.0 worth a major
version, 6–12 months out? Candidate themes (analysts may add, merge or reject them):
1. **Trust that scales down friction:** standing rules / bounded auto-allow (the I1
   amendment v2 deferred), policy learned from audit history, "approve by exception".
2. **Beyond the coding-agent CLI:** cloud/background agents (Claude Code on the web,
   Codex cloud, scheduled/remote jobs), generic agents via an approval API or MCP
   (human-in-the-loop as a primitive any agent or workflow can call), CI/deploy gates.
3. **Driving, not only approving:** dispatching tasks, orchestrating a fleet from the
   phone, voice, handoff between phone, desktop and terminal.
4. **Reach:** native Android, watch, desktop, chat surfaces (Slack/Teams) — each judged
   against D7/ADR 0017 (a decision needs a fresh, user-verified device signature).
5. **Organisation grade:** SSO/SCIM, managed policy distribution, compliance evidence
   (SOC 2-style audit export), self-host relay + push gateway, data residency.
6. **Business:** hosting/pricing model, open-core vs closed, what a solo developer plus
   an AI executor can operate; a v3 counterpart of the v1/v2 kill criteria.

## Rules for every analyst
- Verify against current docs/sources on the web; every verified fact carries a URL,
  everything else is an assumption. Do not repeat v1/v2 facts — cite them by report
  and section.
- Smallest sound design; one developer plus an AI executor. Say what 3.0 should
  **not** contain as clearly as what it should.
- Output exactly one file, `docs/analysis/v3/reports/<NN>-<role>.md`, English, under
  ~500 lines, sections in this order: Summary (≤10 lines) · Verified facts ·
  Assumptions · Findings · Recommendations (with rejected alternatives) · Risks · Work
  items (id `V3-<role letter>NN`, size S/M/L, deps, machine-checkable AC) · Open
  questions for the owner (with defaults) · Sources.
- Do not modify any other file. Do not commit.
