# v3.0 — synthesis of the four analyses

Status: 2026-10-28, draft for owner ratification. Inputs: `reports/01-product.md`,
`02-security.md`, `03-platform.md`, `04-agent-integration.md`. Nothing here is binding
until the owner answers the questions below; v1 decisions D1–D25, invariants I1–I4 and the
v2 draft (`../v2/`) stay.

## Verdict
- No v2 kill criterion has fired (01): Claude Code RC still refuses API keys and gateways,
  Codex remote still needs the ChatGPT desktop host, Coucou/Happy still have no audit or
  signed decisions.
- The market moved anyway: vendors approve with a classifier (Claude Code auto mode is the
  default on every plan), work moves to the cloud (CC on the web, Codex cloud, Cursor cloud
  agents), phone steering is table stakes (Codex "Always approve", Cursor RC beta). Prompt
  volume per user is shrinking.
- The moat is the same, only narrower: **a decision a human signs on a paired device and the
  agent (or gate) verifies, with no transcript on any server**, for setups vendor apps
  cannot reach. Lead claim: "signed, verified, private approvals" (01 Q-V3-5).
- 3.0 is earned **by evidence, not features**. Default outcome: **no 3.0 label**, ship
  2.x minors, unless demand gate V-G1 passes and the I1 ADR is accepted (01 Q-V3-1). On
  branch B (v2 collapsed into 1.x) the label is never used.

## One new review law (02 §1.2)
*An approval is worth only what its enforcement point is worth.* Every 3.0 feature names
the component that checks the device signature and holds the credential that acts. If that
component is the requester itself (an MCP tool returning "approved" to the agent that
asked), the feature is **advisory UX** and is labelled so — never sold as control.

## Scope proposal
| In 3.0 (both branches unless marked) | Source |
|---|---|
| Card phishing hardening (bidi/zero-width/homoglyph flags, "agent says" box, titles from parsed input only) — **do now, in 1.x** | 02 V3-S03 |
| Signed standing rules: ADR amending I1 narrowly, rule = UV-signed decision kind, deterministic match, ≤ 7 d, ≤ 50 uses, re-verified per use; agent never creates or widens a rule; learned policy only proposes | 02 §5.1, V3-S01/S02/S04; 01 V3-P04/P10 |
| "Exceptions only" preset (phone sees only ask-rule, critical and classifier-denied prompts) | 01 V3-P07 |
| Requester peer: paired ask-only identity that seals a request E2E and verifies the signed decision itself (ADR 0010 verifier extracted to `packages/decision-verify`); `remotectl approve` CLI with exit codes as CI/deploy gate | 04 V3-A02–A05, 02 V3-S05 |
| Advisory MCP tool `request_human_approval` (labelled advisory) — **gated on V-G2** | 04 V3-A08, 02 V3-S06, 01 V3-P09 |
| Claude Code `Elicitation` forwarding (form mode → phone, URL mode → decline) | 04 V3-A06 |
| Phone dispatch to `claude --cloud` (one new literal argv target, D13 holds); on-device dictation | 04 V3-A09/A10 |
| Stateless push gateway (APNs + FCM), publisher-run, metadata + sealed blob only; `.p8` leaves the relay | 03 V3-C01–C04 |
| Version gate (`upgrade_required`, N/N-1 skew CI) and one `mobile-release.yml` (EAS → TestFlight/Play internal), no OTA | 03 V3-C11–C13 |
| Watch = notification mirror with Deny only; desktop = installable PWA | 03 V3-C14/C15 |
| Copilot CLI adapter — only if spike passes | 04 V3-A11/A12 |
| Native Android — **gated on demand** (named users) | 03 V3-C05–C10 |
| (A) Gate agent + GitHub deployment protection, OIDC requester check, managed policy channel, audit export bundle, SSO/SCIM that only narrow — **gated on ≥ 1 paying org** | 02 V3-S07–S12 |

| Out of 3.0 | Why |
|---|---|
| Self-host relay kit, FSL relicence | 01 OUT, 02 OUT, 03 branch-A only → **out**; gateway contract designed so it stays possible (ADR only on demand) |
| Allow from watch, Slack/Teams, desktop native (Tauri/Electron) | D7/ADR 0017: no fresh user-verified device signature; chat decisions break I1/I3 |
| Approval endpoint on the relay, relay webhooks, MCP elicitation as transport | breaks I1/I3; elicitation asks in the wrong direction (04 §5) |
| Vendor cloud APIs / dedicated cloud adapters; Codex cloud approvals | no per-action surface; gate its PR/deploy instead |
| LLM-scored auto-allow, learned auto-allow | I1; only proposals |
| Orchestration engine, server-side voice | 04: dispatch stays the sealed `start` command |
| Billing code, open core, paid tier before ≥ 3 written team commitments | 01 V-G3 |
| Aider, Amp adapters; Antigravity; Cursor CLI until verified; US cell without a named need; App Attest on the agent | 04, 03 OQ4, 02 Q-V3S8 |

## Conflicts resolved here (owner may override)
1. **Cloud reach — repo hook vs managed-only.** 04 proposes a repo-committed hook recipe;
   02 rejects keys or hooks the agent can write (`.claude/settings.json` is in the
   clone). → **02 wins:** supported cloud mode = server-managed settings with
   `allowManagedHooksOnly` or a runner image (V3-S09); the repo-hook recipe ships only as
   an experiment, cards labelled "sandbox-enforced" (04 Q2). V3-A07 emits the managed
   snippet instead.
2. **Generic approval primitive — gated vs GO.** 01 gates the whole of T2 on V-G2; 04 says
   GO. → **The CLI gate (`remotectl approve`) ships ungated** — it is the real
   enforcement point for CI and reuses the ADR 0010 verifier; **the MCP tool waits for
   V-G2.** 02's local socket (V3-S05) and 04's requester peer are one design: local
   clients over a socket, remote requesters as paired peers; same verifier, same rule.
3. **I1.** 04 needs no amendment (requesters verify, the agent still never grants);
   standing rules do (01, 02). → One ADR, scoped to standing rules only.
4. **Self-host.** 03 IN on branch A; 01/02 OUT → **out of 3.0**; the gateway still ships
   because Android/FCM and `.p8` isolation need it on both branches.
5. **Android.** 03 IN on demand; 01 OUT → **gated on named demand** (Q-V3-7), closed-test
   lead time (12 testers × 14 days) noted so the gate is checked early.

## Findings that matter for v1/v2 now
- 02: no card-level phishing defence exists in the code (grep) → V3-S03 is a 1.x item.
- 03: the relay holds the APNs `.p8` itself; every self-host or multi-cell path needs the
  gateway first.
- 03: no version gate between relay, agent and app before the first store build → V3-C12
  before M4-08 goes public.

## Suggested order
1. V3-S03 card hardening; V3-P01 watch extension, V3-P02/P03 demand counters (cheap, both branches).
2. V3-S01 I1 ADR → owner decision; V3-A02 requester ADR; V3-C12/C13 version gate.
3. Push gateway V3-C01–C04; requester CLI V3-A03–A05; Elicitation V3-A06.
4. Standing rules V3-S02/S04 + exceptions preset V3-P07 (if ADR accepted).
5. Gated: MCP tool (V-G2), Android (demand), Copilot adapter (spike), org items (paying org).
6. V3-P08 go/no-go record decides the label.

## Owner questions (defaults apply until answered)
| # | Question | Default |
|---|---|---|
| Q-V3-1 | "No 3.0 label" as the default outcome, label only on V-G1 + accepted I1 ADR? | Yes |
| Q-V3-2 | Amend I1 for signed standing rules (02 §5.1 bounds)? | ADR first, flag off, ≤ 7 d, ≤ 50 uses, never learned auto-allow |
| Q-V3-3 | Business model: free hosted relay + sponsorship, paid tier after ≥ 3 written commitments? | Yes; no billing code; relay cost cap = v2 cell × 2 |
| Q-V3-4 | Requester role (CLI gate first, MCP after V-G2) as the agent headline? | Yes |
| Q-V3-5 | Cloud reach whose enforcement depends on the vendor sandbox? | Claude cloud only, managed settings, opt-in, labelled |
| Q-V3-6 | Requester keys in CI/cloud env vars? | Yes: phone-fixed label, 10 req/h, one-tap revoke |
| Q-V3-7 | Android in 3.0? Play account type? | Only on named demand; personal account |
| Q-V3-8 | Org features (SSO/SCIM, gate agent, audit export) only with ≥ 1 paying org? | Yes |
| Q-V3-9 | Self-host relay / relicence? | Not in 3.0; MIT stays |
Further per-report questions with defaults: 01 §8, 02 §8, 03 §8, 04 §8.

## Caveats
Sizes in the reports use different units (01: days, 02/04: Opus hours, 03: developer days);
ROADMAP-v3 normalises to S/M/L Opus hours. Several facts are second-hand or unverified —
each report's §3 lists them (notably Claude cloud hook behaviour, A01 spike; Copilot hook
timeout semantics; Expo plan pricing). The v2 draft is itself unratified, so every branch-A
item inherits that uncertainty.
