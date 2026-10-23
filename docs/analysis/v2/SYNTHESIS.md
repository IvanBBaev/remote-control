# v2.0 — synthesis of the four analyses

Status: 2026-10-24, draft for owner ratification. Inputs: `reports/01-product.md`,
`02-security.md`, `03-platform.md`, `04-agent-integration.md`. Nothing here is binding
until the owner answers the questions below; v1 decisions D1–D25 and invariants I1–I4 stay.

## Verdict
- The v1 kill criterion has **not** fired (01). It was too narrow: pressure comes from
  Codex mobile, Coucou and Happy, so "many agents" and "E2E" are no longer differentiators.
- The defensible niche is **verified approvals for agents the vendor's phone app does not
  cover** (API-key/Bedrock/gateway/ZDR users, Codex CLI/IDE users, small teams): signed
  per-request approval checked by the agent, audit trail without transcripts.
- Honest cut line (01 §5.4): without proven team demand (V2-P02) the work ships as 1.x
  minors and the "2.0" label is dropped. The first 2.0 task is finding ≥ 3 external users.

## Scope proposal
| In 2.0 | Source |
|---|---|
| Teams-lite: principals + roles, signed policy bundle (narrow-only), delegation, k-of-n quorum, hash-chained audit with relay anchors | 02, 01 T1 |
| Deterministic smart approvals: batch UI, risk labels (tighten-only), proposed allow rules | 01 T3, 04, 02 |
| Adapter ports split (Approval/Session/Feed/Install), guardrails module, fleet view via `claude --bg`, Codex trust-drift installer | 04 |
| Cells-based scaling (2–4 replicas per cell, one cell per region), tenant quotas, ops counters, version-skew gate | 03 |
| TestFlight → App Store | 01 T4, 03 |
| Monthly competitive watch with K1–K5 kill/pivot criteria | 01 |

| Out of 2.0 | Why |
|---|---|
| Standing auto-allow rules (needs ADR amending I1) | 02 Q-S3: ship in 2.1 |
| Native Android, watch (Deny-only mirror), desktop client | 01 OUT; 03 notes Play needs a 12-tester/14-day closed test, start only if Android is chosen |
| Self-host relay + push gateway | 01 OUT vs 03 proposal: defer; `apps/push-gateway` design stays on the shelf |
| Gemini/Antigravity work | frozen until V2-P16 |
| Relay-side cron, LLM scoring, hardware attestation, OTA updates | 04, 02, 03 rejected |

## Conflicts resolved here (owner may override)
1. Self-host: product says out, platform sketches a push gateway → **out for 2.0**.
2. Learned rules: agent report writes them via `updatedPermissions`, security forbids
   agent-side auto-allow → **2.0 proposes, human confirms (session scope); standing rules 2.1**.
3. Android: product out, platform has a long Play lead time → **out unless Q-P owner answer changes**.

## Findings that matter for v1 now
- 02 F-A: relay-visible hashes are only salted if `request_id` is never visible to the relay → add the test (W-S12).
- 02 F-B: `peer_revoked` passes through the relay, which can hold it → local `remotectl peers revoke` + leases before any team use.
- 02: ADR 0016 ledger tables allow noisy-neighbour DoS → per-tenant quotas.
- 03: Railway domain cap ≈ 10k connections (≈ 3k users/cell); NOTIFY commit lock and full queue are the real PgNotify risks → 4-replica soak test + queue alert.

## Suggested order
1. V2-P02 demand check + V2-P01 watch script + V2-P04 positioning ADR (cheap, decides whether "2.0" exists).
2. Security base: W-S12 test, local revoke, principals/roles, policy bundle.
3. Agent ports + protocol fields (V2-AG-01…03), guardrails, batching.
4. Platform cells, quotas, counters, version gate.
5. Quorum, delegation, audit chain; TestFlight/App Store.

## Owner questions (defaults in each report §8)
Highest leverage: Q-P1 positioning + K1–K5; Q-P2 allow a "no 2.0 label" outcome; Q-P5 name ≥ 3
first external users; Q-P4 team cap (≤ 10, no SSO); Q-S2/Q-S3 (no admin-signed principal
expansion, no I1 amendment in 2.0); Android yes/no; self-host yes/no. All defaults stand until answered.

## Caveats
Cost figures (≈ $19/month per 1,000-user cell) are modelled, not measured. Several facts are
second-hand (Codex mobile details, Antigravity hooks, `--max-budget-usd`, Gemini ACP, parent ids
in subagent payloads, Apple Secure Enclave/App Attest pages). Reports §3 list them.
