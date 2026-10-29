# remote-control — Roadmap v3.0 (draft)

Status: 2026-10-28. Derived from `SYNTHESIS.md` and the four reports in `reports/`.
Execution rules are those of `docs/analysis/ROADMAP.md` §0 and §5; decisions D1–D25,
invariants I1–I4 and the v2 draft still bind. Owner questions in `SYNTHESIS.md` and each
report §8 have defaults that apply until answered. Items marked **gated** must not start
before the named condition. Nothing here starts before the v2 tail it depends on is done.

Statuses: `todo`, `done <sha>`, `gated:<why>`. Sizes S=1 h, M=2 h, L=4 h Opus 5.5
(normalised; reports differ). Branch: AB = both, A = only if v2 teams shipped.
Work-package ids are the report ids; the report holds scope and machine-checkable AC.
Parallel work: lanes, path ownership, reserved names and sync points are in `PARALLEL.md`;
claim an item by setting `doing <lane>` here on `main` before branching.

## Phase A — evidence and cheap hardening (valid with or without 3.0)
| ID | Item | Report | Br | Size | Status |
|---|---|---|---|---|---|
| V3-S03 | Card phishing hardening (bidi, zero-width, homoglyph, "agent says", parsed titles) | 02 §7 | AB | M | done a399db6 |
| V3-S03b | Push summary revealed by the agent: `p`, `l`, `s` carry `⟨U+XXXX⟩` markers, fitted to the schema caps (Swift extension, widget, Live Activity get safe text) | 02 §7 | AB | S | done 8f63206 |
| V3-S03c | Native app: tool label derived from `toolName` on the phone; inbox, session titles and widget snapshot revealed | 02 §7 | AB | S | done 530c25c |
| V3-S03d | Mobile `cards.tsx` renders only `ApprovalCardText` (type-enforced reveal, no RN render test) | 02 §7 | AB | S | doing sec-cards |
| V3-P01 | Vendor-watch script: V-K1…V-K4 strings | 01 §7 | AB | S | gated:v2 watch script (V2-P01) |
| V3-P02 | Local `remotectl stats` demand counters (no telemetry) | 01 §7 | AB | S | todo |
| V3-P03 | V-G2 demand gate record (`v3/gates.md`) | 01 §7 | AB | S | todo |
| V3-P06 | README positioning + dated comparison table | 01 §7 | AB | S | gated:owner Q-V3-5 |
| V3-C12 | Version gate (`upgrade_required`, MIN_* versions) | 03 §7 | AB | S | todo |
| V3-C13 | Skew CI job against the last published `remotectl` | 03 §7 | AB | S | after V3-C12 |

## Phase B — decisions (ADRs)
| ID | Item | Report | Br | Size | Status |
|---|---|---|---|---|---|
| V3-S01 | ADR: standing rules amend I1 (+ "Enforcement point" ADR field) | 02 §5.1 | AB | S | gated:v2 W-S1; owner Q-V3-2 |
| V3-A02 | ADR: requester peer (role, binding, nonce, rate limit, revoke) | 04 §7 | AB | M | todo |
| V3-S13 | SECURITY.md 3.0 section | 02 §7 | AB | S | after V3-S01 |

## Phase C — foundations
| ID | Item | Report | Br | Size | Status |
|---|---|---|---|---|---|
| V3-C01 | `apps/push-gateway` (stateless, registration keys, rate limit) | 03 §7 | AB | M | gated:M4-05 done |
| V3-C02 | Relay `GatewayPushSender` behind the push port | 03 §7 | AB | S | after V3-C01 |
| V3-C03 | Gateway deploy, keys, rotation runbook | 03 §7 | AB | S | gated:owner Railway/Apple keys |
| V3-C04 | FCM v1 adapter in the gateway | 03 §7 | AB | S | after V3-C01 |
| V3-C16 | Gateway/relay counters, redaction list | 03 §7 | AB | M | after V3-C01 |
| V3-A03 | `packages/decision-verify` (ADR 0010 verifier, zero deps) | 04 §7 | AB | M | after V3-A02 |
| V3-A04 | `remotectl pair --role requester` + `remotectl approve` (exit codes) | 04 §7 | AB | M | after V3-A03 |
| V3-S05 | Local approval socket (per-client tokens, deadline, decide-once) | 02 §7 | AB | M | after V3-A04 (same verifier); gated:v2 V2-AG-03 |
| V3-A05 | `--hook claude` / `--hook copilot` translators | 04 §7 | AB | S | after V3-A04 |
| V3-A06 | Claude Code `Elicitation` forwarding | 04 §7 | AB | S | todo |
| V3-C11 | `mobile-release.yml` (EAS → TestFlight/Play internal) | 03 §7 | AB | M | gated:M4-08 |

## Phase D — 3.0 features
| ID | Item | Report | Br | Size | Status |
|---|---|---|---|---|---|
| V3-S02 | Standing rules engine (refines v2 W-S11) | 02 §7 | AB | L | gated:V3-S01 Accepted, v2 W-S2/W-S5 |
| V3-S04 | Rule proposals from the local audit | 02 §7 | AB | M | after V3-S02 |
| V3-P07 | "Exceptions only" preset | 01 §7 | AB | M | after V3-P02 data |
| V3-A08 + V3-S06 | `remotectl mcp`: advisory `request_human_approval` | 04/02 §7 | AB | M | gated:V-G2 |
| V3-A01 | Spike: Claude cloud session hooks | 04 §7 | AB | S | gated:claude.ai cloud access |
| V3-S09 | Cloud-session mode (managed settings only; refuse repo keys) | 02 §7 | AB | M | after V3-A01 |
| V3-A07 | Cloud recipe emitting the managed-settings snippet (repo hook = labelled experiment) | 04 §7 | AB | S | after V3-S09 |
| V3-A09 | Phone dispatch to `claude --cloud` | 04 §7 | AB | S | after V3-A01 |
| V3-A10 | On-device dictation | 04 §7 | AB | S | todo |
| V3-C14 | Watch Deny verification | 03 §7 | AB | S | todo |
| V3-C15 | Desktop PWA install + badge | 03 §7 | AB | S | todo |
| V3-A11 | Spike: Copilot CLI / Cursor CLI | 04 §7 | AB | S | todo |
| V3-A12 | Copilot CLI adapter | 04 §7 | AB | M | gated:V3-A11 go |
| V3-C05…C10 | Native Android (build, Keystore key, FCM, actions, passkeys, Play closed test) | 03 §7 | AB | L+ (+14 d) | gated:owner Q-V3-7 named demand |

## Phase E — organisation grade (branch A, gated: ≥ 1 paying org, Q-V3-8)
V3-S08 OIDC requester check, V3-S07 gate agent + GitHub deployment protection, V3-S10
managed policy channel, V3-S11 SSO/SCIM (narrow only), V3-S12 audit export bundle,
V3-A13 requester in policy bundle / quorum, V3-C21 chat notify sink (notify only).

## Out of 3.0 (defaults, see SYNTHESIS.md)
Self-host kit and relicence (V3-C17–C19, V3-S14 only on demand); cells beyond EU
(V3-C20); Allow from watch/chat/desktop-native; relay approval endpoint; vendor cloud
APIs; learned or LLM auto-allow; orchestration engine; billing code; Aider, Amp,
Antigravity adapters.

## Go / no-go
V3-P08 (01 §7) records V-G1, V-G2, V-G3, the V3-S01 status and V-K1…V-K7 in
`docs/analysis/v3/gates.md` with a verdict `3.0` / `2.x minors` / `maintenance`.
Default: `2.x minors`.
