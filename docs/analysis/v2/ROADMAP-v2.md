# remote-control — Roadmap v2.0 (draft)

Status: 2026-10-24. Derived from `SYNTHESIS.md` and the four reports in `reports/`.
Execution rules are those of `docs/analysis/ROADMAP.md` §0 and §5; decisions D1–D25 and
invariants I1–I4 still bind. Owner questions in each report §8 have defaults that apply
until answered. Items marked **gated** must not start before the named condition.

Statuses: `todo`, `done <sha>`, `gated:<why>`. Sizes S=1 h, M=2 h, L=4 h Opus 5.5.
Work-package ids are the report ids; the report holds scope and machine-checkable AC.

## Phase A — decide whether 2.0 exists (no code risk)
| ID | Item | Report | Size | Status |
|---|---|---|---|---|
| V2-P01 | market-watch script (K1–K3) | 01 §7 | M | todo |
| V2-P16 | Antigravity hook-surface research | 01 §7 | S | todo |
| V2-P02 | Demand evidence (≥ 5 rows) | 01 §7 | M | gated:needs owner-named users (Q-P5) for interviews; public-thread part can start |
| V2-P04 | ADR positioning + kill criteria | 01 §7 | S | gated:owner Q-P1 |
| V2-P03 | README comparison refresh | 01 §7 | S | todo after V2-P01 |

## Phase B — v1 hardening found by the analyses (valid with or without 2.0)
| ID | Item | Report | Size | Status |
|---|---|---|---|---|
| W-S12 | Relay never sees `request_id` / `request_hash` test | 02 §7 | S | todo |
| W-S14 | Local `remotectl peers revoke` + last-heard indicator | 02 §7 | S | todo |
| W-S13 | Tenancy: ledger quotas, global signup limiter, push cap | 02 §7 | M | todo |
| P-2 | Queue/socket metrics + runbook alerts | 03 §7 #2 | S | todo |
| P-5 | Per-account quotas | 03 §7 #5 | M | todo |
| P-1 | 4-replica soak on staging | 03 §7 #1 | M | gated:staging deploy, owner run |

## Phase C — 2.0 foundations
| ID | Item | Report | Size | Status |
|---|---|---|---|---|
| W-S1 | ADR set (principals, quorum, audit, rules/I1, enroll) | 02 | S | todo |
| V2-AG-01 | Fixtures spike for Claude fleet/subagent payloads | 04 | S | gated:needs real claude CLI |
| V2-AG-02 | Protocol fields + event kinds | 04 | M | after V2-AG-01 |
| V2-AG-03 | Adapter port split | 04 | M | after V2-AG-02 |
| W-S2 | Principals, roles, scopes | 02 | M | after W-S1 |
| W-S5 | Hash-chained audit log + verify | 02 | M | after W-S2 |
| W-S3 | Monotone policy + signed bundle | 02 | M | after W-S2 |
| V2-AG-05/06 | Guardrails; deterministic summaries and risk tags | 04 | M+S | after V2-AG-03 |
| P-4 | Cells config, per-pairing `relayUrl` | 03 §7 #4 | M | todo |
| P-6/7 | Team schema; cross-tenant property test | 03 §7 #6–7 | M+M | after W-S1 |
| P-12 | Mobile release workflow + version gate | 03 §7 #12 | M | after M4-08 |

## Phase D — 2.0 features
W-S4 quorum, W-S6 audit anchors, W-S7 delegation, W-S8 enroll, W-S9 key hygiene,
W-S10 risk friction, V2-P05 batch approval (= V2-AG-07), V2-P07 / V2-AG-08 rule proposals,
V2-P08 policy bundle UX, V2-P09 delegate UX, V2-P10 audit export, V2-P11 quorum (**gated:**
demand evidence), V2-P12 budget guardrail, V2-P13 gateway hardening, V2-P14 Codex real run,
V2-P15 App Store package, V2-AG-04/09/10 fleet, Codex hardening, schedule observation,
P-13/14 ops counters and opt-in telemetry, P-8 grantee routing.

## Out of 2.0 (defaults, see SYNTHESIS.md)
W-S11 standing rules (2.1, ADR amends I1); P-9/P-10 push gateway and self-host; P-11 Android;
P-15 watch spike; Gemini/Antigravity adapter; desktop client.

## Cut line
If V2-P02 shows no team demand, Phase D team items stay unbuilt and what ships is released as
1.x minors without the "2.0" label (Q-P2).
