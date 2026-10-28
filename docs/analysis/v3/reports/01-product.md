# v3 analysis — 01 Product & business strategy

Analyst: product & business strategist. Date: 2026-10-28. Inputs: `v3/00-brief.md`,
`v2/SYNTHESIS.md`, `v2/ROADMAP-v2.md`, `ROADMAP.md` §1 (I1–I4, kill criterion),
`v2/reports/01-product.md` (cited as **v2-P §n**; v1 product report cited as **v1-P**).
Facts verified on the web on 2026-10-28; URLs in Sources.

## 1. Summary

- No v2 kill trigger has fired. RC still refuses API keys and gateways (K1), Codex's remote
  host still needs the ChatGPT desktop app (K2), and Coucou and Happy still ship no audit log
  and no signed decisions (K3).
- The market moved in three directions: (1) the vendors now approve with a classifier (Claude
  Code auto mode is the default for every plan); (2) work goes to the cloud (CC on the web,
  Codex cloud, Cursor cloud agents, Grass VMs); (3) phone steering is now standard (Codex mobile
  has "Always approve", Cursor shipped an RC beta).
- Our defensible position is the same one, only narrower: **an approval that a human signs on
  a paired device and the agent verifies, with no transcript on any server**, for agents the
  vendor apps cannot reach (API key / gateway / ZDR / Codex CLI / mixed agents).
- 3.0 is earned **only by evidence, not by features**. Recommended: two themes are IN, both
  small and gated — T1 bounded signed standing rules (needs an I1 ADR) and a thin slice of T2,
  a signed-approval endpoint for non-agent callers. T3, T4, T5 and most of T6 are OUT.
- The honest default is **"no 3.0 label"**. Ship 2.x minors unless gate V-G1 (demand) and the
  I1 ADR both pass. Business model: free hosted relay, MIT code, no billing code until ≥3 teams
  commit to pay in writing, no self-host licence.

## 2. Verified facts (new since 2026-10-24; v2-P §2 F1–F20 still hold unless noted)

| # | Fact | Source |
|---|---|---|
| G1 | RC docs still say "API keys are not supported". Bedrock, Agent Platform, Foundry and `ANTHROPIC_BASE_URL` gateways stay excluded. The transcript is stored by Anthropic, so ZDR/HIPAA orgs cannot enable RC. Trusted Devices is still beta. Push has two toggles, "no per-event configuration". Claude Code is the only agent. No "Always" on the phone. (Updates v2-P F-series: still true.) | S1 |
| G2 | RC docs now contain an "away from terminal" comparison table: Dispatch (task from mobile to Desktop), RC, Channels, Slack, Self-hosted environments, Scheduled tasks. Forwarded non-permission dialogs expire after 5 min (`dialogExpiry`); permission prompts stay open. | S1 |
| G3 | Changelog 2.1.308–2.1.312 (Oct 22–27): RC status/"Connecting" fixes, Enterprise custom roles now gate cloud sessions and RC, a Windows PreToolUse/PermissionRequest hook fail-open fix, `claude daemon stop --any`, and a fix for mobile showing Claude's messages as the user's. **Nothing adds Always, API-key RC or a second agent.** | S2 |
| G4 | Channels **permission relay** (research preview) is an official approval API for Claude Code. The server declares `claude/channel/permission` and receives `request_id`, `tool_name`, `description`, `input_preview` (sanitized, credentials masked). It answers with `behavior` allow/deny. "Neither verdict affects future calls" (no Always). The terminal dialog races it and the first answer wins. Auth is claude.ai or a Console API key, not Bedrock/Agent Platform/Foundry. Custom channels need `--dangerously-load-development-channels` or an org allowlist. It does not work with `-p` or the Agent SDK. Decisions are **not signed**. (v1-P already rejected building on Channels; nothing material has changed.) | S3, S4 |
| G5 | Self-hosted environments (public beta, Team/Enterprise, off by default): runners sit in the customer network, the control plane is Anthropic's, the transcript still goes to api.anthropic.com, and ZDR/HIPAA orgs cannot use it. | S5 |
| G6 | **Auto mode**: a classifier model reviews actions instead of the human. It is available on all plans and on Bedrock/Agent Platform/Foundry with newer models. From v2.1.283 it is the starting mode for interactive sessions on every plan and provider. Never auto-approved: explicit `ask` rules, AskUserQuestion, `requiresUserInteraction` MCP tools, critical `rm`. | S6 |
| G7 | Codex remote connections: the host must run the **ChatGPT desktop app** (macOS/Windows), and "you can't set it up from the Codex CLI or IDE extension". No API-key path is documented. Admins may need to enable it. | S7 |
| G8 | Codex mobile: tasks run "in the cloud or on a connected computer". Approval choices are **Approve / Always approve / Deny** plus redirect. Available on all plans incl. Free/Go since the May 2026 preview. Users are publicly asking for push notifications on approval requests. | S8, S9, S10 |
| G9 | Cursor: cloud agents run in VMs and start from the iOS app, web/PWA, Slack, GitHub, Linear or the API. They need a paid plan and offer a "Self-Hosted Machines" option. The iOS app has a **Remote Control beta** for local agents ("agent loop moves to the cloud while its tools keep running on your machine"), Live Activities and PR merges. No per-command approval is documented. Users are asking for approvals from OS notifications. | S11, S12, S13 |
| G10 | Coucou: 6.6k stars (was 6.3k on 10-24), releases 0.5.3 desktop and Android 0.3.0 on Oct 22. Face ID per Allow, Android fingerprint, stateless Worker relay, decisions bound to the exact request, HMAC on WhatsApp deliveries. **No audit log**, App Store "coming soon", free; MIT code with proprietary assets. K3 not triggered. | S14 |
| G11 | Happy: 24.4k stars, MIT, E2E, Claude Code + Codex (+ more). Self-hostable happy-server. App Store listing is free with in-app purchases (contents unpublished). Signed per-request decisions are not documented. K3 not triggered. | S15, S16 |
| G12 | Grass: a mobile control layer for Claude Code, Codex and OpenCode. Native Allow/Deny, MIT local CLI over WiFi/Tailscale, and **paid hosted cloud VMs** (free tier of 10 h). Source is the vendor's own blog (inconsistent date), so it is weak evidence. | S17 |
| G13 | HumanLayer has pivoted from a HITL approval SDK to a "multiplayer coding agent IDE and cloud". Pricing: Starter free (3 seats, 200 sessions/month), Pro **$100/user/month** (BYOK Claude Code/Codex, remote daemons), Enterprise custom (SSO, audit logs, on-prem). Its homepage no longer mentions an approval API. | S18 |
| G14 | Small HITL-approval APIs exist (The Handover REST API, gotoHuman), and workflow platforms ship HITL as a pattern (UiPath policy, Temporal cookbook, Cloudflare Agents). No major lab sells a standalone signed-approval API. | S19–S23 |
| G15 | MCP elicitation (spec 2025-11-25) gives servers a standard way to ask the user via the client: form mode, plus URL mode for out-of-band sensitive steps, with accept/decline/cancel. It has no signature or device binding. Clients "SHOULD implement user approval controls". | S24 |

## 3. Assumptions (validate or drop)

| # | Assumption | How to validate |
|---|---|---|
| B1 | Auto mode (G6) lowers phone prompt volume enough that "approve every prompt" stops being the main job. The remaining value is concentrated in *exception* prompts: ask rules, critical commands, and users who turn auto mode off. | V3-P02 telemetry-free survey + local counter in `remotectl stats` (opt-in, local only). |
| B2 | Users who are refused by RC (API key, gateway, ZDR, Codex CLI) remain the core segment (v2-P A1). It is still unsized. | V3-P02 demand check; issue-tag counts. |
| B3 | Someone besides coding agents (CI deploy gates, Agent SDK apps, cron scripts) wants "a human signed this on a phone" as an API. | V3-P03 landing-page/issue demand gate (V-G2). |
| B4 | ≥3 small teams would pay a recurring fee for a hosted team relay with signed audit export. | V3-P05 written commitments, no billing code. |
| B5 | One developer plus an AI executor can run a free hosted relay at the v2 cell scale with no on-call beyond best-effort. | Existing v2 cell cost data; fails if monthly relay + APNs + Apple fees exceed the owner's set cap (Q-V3). |
| B6 | Vendors will not ship *signed, device-bound* approvals within 6 months; their direction is classifier approval (G6) and cloud execution (G5, G9). | V-K watch (V3-P01). |

## 4. Findings

### 4.1 Market delta in one table

| Player | 2026-10-24 (v2-P §2) | 2026-10-28 | Effect on us |
|---|---|---|---|
| Claude Code RC | Subscription only, no Always | Same. Added comparison table, Enterprise roles, fixes (G1–G3) | Gap holds. K1 not triggered. |
| Claude Code auto mode | Present | **Default starting mode on every plan/provider** (G6) | Fewer prompts reach any phone. Our job shifts to exceptions and policy. |
| Channels permission relay | Research preview (v1-P) | Same, documented in detail; unsigned, no Always, Console keys OK (G4) | A free competitor surface for API-key users, but no signatures, a dev flag, and Claude-only. Monitor (V-K2). |
| Codex mobile | Remote via desktop app | Approve / **Always approve** / Deny; still desktop-app host (G7, G8) | Codex users of the ChatGPT app are served. Codex CLI users are not. K2 not triggered. |
| Cursor | Background agents | iOS app + RC beta + cloud agents, paid (G9) | Cursor users are served by the vendor. Not our segment. |
| Coucou / Happy | 6.3k / ~24k stars | 6.6k / 24.4k, Android shipped (G10, G11) | Free, multi-agent, growing. Our differentiator is the signed audit plus agent-side verification, not reach. |
| Grass / HumanLayer | Not tracked | Paid VMs / $100-per-seat agent IDE (G12, G13) | Money in this space comes from **compute and seats in a workspace**, not from approvals alone. |
| HITL APIs | Not tracked | Small, crowded, unsigned (G14, G15) | A signed-approval endpoint is differentiated but small. Demand is unproven (B3). |

### 4.2 What the delta means

1. **The "approve every tool call from the phone" job is shrinking.** The vendor default is
   now a classifier (G6), and Codex offers "Always approve" (G8). A product that only mirrors
   prompts will see falling usage even with happy users. That argues *for* T1 (fewer but more
   meaningful prompts, plus bounded standing rules), and against adding surfaces (T4).
2. **Signatures and verification remain unique.** No vendor surface (RC, Channels, Codex,
   Cursor) or open-source competitor (Coucou, Happy, Grass) documents a decision that the agent
   side cryptographically verifies, nor a signed audit trail. This is the moat (v2-P §5.1). It
   is narrow and must be stated in one sentence.
3. **Cloud agents are out of reach and should stay so.** CC on the web, Codex cloud and Cursor
   cloud agents run on vendor infrastructure with the transcript there (G5, G9). There is no
   hook surface for us, and our privacy promise (I3) adds nothing there. T2's "cloud agents"
   half is OUT.
4. **The monetisable layer is not approvals.** Grass monetises VMs and HumanLayer monetises
   seats in a full IDE (G12, G13). A one-person project cannot run VMs, and an IDE breaks the
   scope. A small paid team tier (audit export, team relay quota) is the only plausible revenue
   and is unproven (B4).
5. **Channels is the most likely silent killer.** If Anthropic adds signed or "Always"
   verdicts to the Channels permission relay and drops the dev flag, API-key users get a free
   first-party path. Today it lacks all three (G4).

### 4.3 Theme verdicts (brief themes 1–6)

| Theme | Verdict | Why (short) |
|---|---|---|
| T1 Smarter/standing approvals | **IN, narrow**: signed, expiring, scope-bounded standing rules created only by a fresh device signature and verified by the agent-side hook; "approve by exception" defaults that line up with auto mode. Needs an ADR amending I1 (v2 deferred it, v2-P §5.2). **No learned or LLM auto-allow.** | Direct answer to G6/G8; uses our moat (the signature); small. |
| T2 Generic HITL / approval API | **IN, thin and gated** (V-G2): one signed-approval endpoint (`remotectl request --wait` CLI + a minimal MCP tool), usable by CI deploy gates, scripts and Agent SDK apps. Cloud-agent integration is **OUT**. | Reuses the existing pairing and crypto. Differentiated from G14/G15 by signatures. Demand unproven, hence the gate. |
| T3 Driving / dispatch / voice | **OUT** | Vendors own it (Dispatch, Codex redirect, Cursor RC; G2, G8, G9). Conflicts with the minimal-surface rule. |
| T4 More surfaces (Android native, watch, desktop, Slack) | **OUT**. The only exception, possibly in a 3.x minor, is a Deny-only watch mirror. | A fresh device signature per decision (D7 / ADR 0017) cannot live in chat surfaces. Android stays PWA (v2 deferral stands). Coucou already covers Android reach. |
| T5 Enterprise (SSO/SCIM, SOC 2, self-host relay) | **OUT**. Self-host is a licence question only (see §5.3). | A one-person operator cannot carry SOC 2 or on-call. HumanLayer prices enterprise at custom tiers with a team behind it (G13). |
| T6 Business model | **IN as a decision, not code**: free hosted relay plus MIT code. A paid team tier exists only after written commitments (V-G3). No billing code until then. | Keeps the operating load at one person. Avoids building billing for zero customers. |

### 4.4 Branches

- **Branch A (v2 shipped with teams):** teams exist, so T1 standing rules can have a team
  owner scope and the paid tier hypothesis (B4) has candidates to ask. 3.0 = T1 + T2-thin +
  pricing decision.
- **Branch B (v2 collapsed into 1.x, cut at V2-P02 demand):** there is no team base. T1 ships
  as a single-user 1.x/2.x minor. T2-thin only if V-G2 passes. No paid tier at all. **No 3.0
  label** — releasing a "3.0" over a collapsed 2.0 would signal momentum that does not exist.

## 5. Recommendations

### 5.1 Positioning (one sentence each)

- **A:** "The signed approval plane for small teams running mixed coding agents — every
  Allow is signed on a paired phone and verified by the agent; no transcript leaves your
  machines."
- **B:** "Verified phone approvals for the agents your vendor app can't reach — API-key,
  gateway, ZDR and Codex CLI setups — plus a signed-approval call for your scripts."
- Both: drop "remote control" as the lead claim. Vendors own that phrase (RC, Cursor RC).
  Lead with *signed, verified, private*. Refresh the README comparison against G1–G13
  (V3-P06).

Rejected: (a) "a better RC for everyone" — vendor parity is unwinnable and K1 makes it
fragile; (b) "a HITL platform for AI agents" — crowded (G14), and pivots like HumanLayer's
(G13) show the standalone category is thin; (c) "a privacy-first Cursor/Grass alternative with
cloud VMs" — needs compute operations a single developer cannot run.

### 5.2 Release scope

**3.0 contains (only if gates pass):**
1. T1: signed standing rules (ADR first; expiry ≤ 24 h default and ≤ 7 d max; scope =
   agent + project path + tool + argument pattern; revocable from the phone; every use
   logged in the signed audit). Behind a flag in the first minor.
2. T1: "exceptions only" preset that mirrors auto mode — the phone gets ask-rule, critical
   and denied-by-classifier prompts, not every tool call.
3. T2-thin: `remotectl request` CLI + one MCP tool `request_approval` returning a signed,
   verifiable verdict. No SDKs in other languages, no webhooks, no hosted API keys.
4. Positioning/README/pricing page refresh (no billing code).

**3.0 does NOT contain:** driving/dispatch/voice, cloud-agent integrations, Android native,
desktop app, Slack/Teams/WhatsApp approvals, SSO/SCIM, SOC 2, self-host relay packaging,
LLM risk scoring, learned auto-allow, billing/subscription code, Gemini/Antigravity adapters
(still a v2 deferral; revisit only if a user asks with an issue), a Channels-based adapter.

**The honest "no 3.0" outcome (default):** if V-G1 fails or the I1 ADR is rejected, ship
T1-preset and any accepted pieces as 2.x minors, keep the free relay, and record the decision
(V3-P08). This is a valid result, not a failure.

Rejected alternatives: (a) "3.0 = Android + watch + desktop" — surface growth against a
shrinking prompt volume (§4.2.1); (b) "3.0 = enterprise edition" — operator load (T5);
(c) "3.0 = cloud agents" — no hook surface, I3 adds nothing (§4.2.3); (d) a version bump for
marketing — misleading in branch B.

### 5.3 Business model a single developer can run

| Option | Verdict |
|---|---|
| Free hosted relay + MIT code (status quo, v2-P Q-P3 default) | **Keep** as the base. Cost cap set by the owner (Q-V3-3). |
| Paid team tier (hosted, e.g. flat per-team monthly: signed audit export, higher relay quota, team rules) | **Only after V-G3**: ≥3 teams commit in writing. Start with manual invoicing (Stripe payment links or Polar), no in-app billing. Price anchor: well under HumanLayer's $100/user (G13); propose a flat per-team price, owner decides. |
| Sponsorship (GitHub Sponsors / Polar) | **Yes**, zero code, now. Covers the Apple developer fee and relay costs. |
| Open core (closed paid features) | **No**. It splits the codebase and requires licence enforcement. The paid value is the *hosting*, not code. |
| Self-host licence (source-available relay, commercial licence) | **No for 3.0**. Every self-host install is a support channel, and relay self-host is a v2 deferral. Revisit only in branch A if ≥2 paying teams request it for ZDR reasons. |
| Hosted VMs (Grass-style) | **No**. Compute operations are beyond one person, and it is outside the product. |

### 5.4 v3 kill / pivot criteria (successors of v2-P §5.3 K1–K5)

| # | Trigger | Action |
|---|---|---|
| V-K1 (was K1) | RC supports API key **or** gateway **and** offers "Always" from the phone. | Stop Claude Code-only positioning. Keep Codex CLI + signed approvals; re-evaluate within 2 weeks. |
| V-K2 (new) | The Channels permission relay leaves research preview without the dev flag **and** adds either persistent verdicts or signed/device-bound verdicts. | Same as V-K1 for API-key users. Consider becoming a Channels transport (v1-P noted the option) instead of a hook. |
| V-K3 (was K2) | Codex remote connections accept a CLI/IDE host or an API key. | Drop Codex from the headline. Keep the adapter while it works. |
| V-K4 (was K3) | Coucou, Happy or Grass ships signed per-request decisions **and** an exportable audit log. | Pivot to contributing upstream or narrow to team policy (branch A); no 3.0. |
| V-K5 (was K4, sharpened) | 90 days after 1.0: < 3 external users with ≥ 5 approvals per week, **or** the median approvals per active user fall > 50 % after auto mode (B1). | Freeze features. Maintenance-only. No 3.0. |
| V-K6 (was K5) | App Store rejects twice. | PWA only; stop native work. |
| V-K7 (new, business) | 60 days after the pricing page: < 3 written team commitments. | No paid tier. Free plus sponsorship only. Drop V3-P05 follow-ups. |

### 5.5 Gates for the 3.0 label

- **V-G1 demand:** ≥ 10 external active users (≥ 5 approvals/week, self-reported or opt-in
  local count) **and** ≥ 3 issues/discussions asking for standing rules or exception mode.
- **V-G2 HITL API:** ≥ 5 distinct external requests (issues, discussion upvotes, landing-page
  sign-ups) for a non-agent approval call before any T2 code.
- **V-G3 revenue:** ≥ 3 written team commitments before any billing work.
- The 3.0 label requires V-G1 **and** the I1 ADR accepted. V-G2 and V-G3 only add scope.

## 6. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Anthropic upgrades Channels (V-K2) or RC (V-K1) and the core segment disappears. | M | H | Watch script (V3-P01); keep scope small so a pivot is cheap. |
| R2 | Standing rules weaken I1 in practice (users set broad rules, so the agent effectively self-grants). | M | H | Hard caps (scope fields mandatory, expiry max 7 d), signature per rule, audit per use, ADR with threat review (security report). |
| R3 | Auto mode collapses prompt volume, so the product feels idle (B1). | H | M | "Exceptions only" preset; measure via V-K5. |
| R4 | T2 attracts users with needs we cannot serve (SLAs, webhooks, multi-tenant APIs). | M | M | Thin scope; explicit "not a platform" statement; V-G2. |
| R5 | Free hosted relay costs outgrow sponsorship. | L | M | Owner cap (Q-V3-3); per-device rate limits already in v2 cells. |
| R6 | A paid tier creates support expectations a single developer cannot meet. | M | M | Manual invoicing, a written best-effort support statement, no SLA. |
| R7 | Competitor facts age quickly (Grass, Cursor RC in beta). | H | L | Date every claim in the README comparison; V3-P01 re-check monthly. |

## 7. Work items

| Id | Title | Size | Deps | Acceptance criteria (machine-checkable) |
|---|---|---|---|---|
| V3-P01 | Extend the vendor-watch script with V-K1…V-K4 strings (RC "API keys are not supported", Channels "research preview" / "dangerously-load-development-channels" / "affects future calls", Codex "can't set it up from the Codex CLI", Coucou/Happy README "audit"). | S | v2 watch script (V2-P series) | `pnpm watch:vendors --json` exits 0 and prints one object per V-K id with `{id, url, matched: boolean}`; a fixture test flips each to `matched=false` and exits 1. |
| V3-P02 | Demand check for exception mode / standing rules: an opt-in local counter in `remotectl stats` (prompts, approvals, by rule class) and a pinned discussion. No telemetry leaves the machine. | S | 1.0 shipped | `remotectl stats --json` prints `approvals_7d`, `prompts_7d`, `by_class`; a test asserts no network call during `stats` (nock/undici mock records 0 requests). |
| V3-P03 | V-G2 demand gate for the signed-approval call: a README section plus a discussion form; record the count in `docs/analysis/v3/gates.md`. | S | — | `docs/analysis/v3/gates.md` contains a line matching `^V-G2: \d+ requests \(as of \d{4}-\d{2}-\d{2}\)$`. |
| V3-P04 | ADR: bounded signed standing rules (amends I1). Fields, caps, revocation, audit, and the threat model with the security analyst. | M | security report v3 | `docs/adr/NNNN-signed-standing-rules.md` exists with `Status: (Accepted|Rejected)`, and sections `## Caps`, `## Revocation`, `## Audit`, `## Threats`; `pnpm check` green. |
| V3-P05 | Pricing/commitment page (static, no billing code) plus a sponsorship link. | S | Q-V3-3 answered | The README contains a `## Pricing` heading; `grep -ri "stripe\|billing" packages/ apps/` returns 0 matches in code; `gates.md` has a `V-G3:` line. |
| V3-P06 | Positioning and comparison refresh: README table vs RC, Channels, Codex mobile, Cursor, Coucou, Happy, Grass, each cell dated. | S | — | The README comparison table has ≥ 7 competitor rows, and each row has a `(as of YYYY-MM-DD)` stamp; a markdown-link check passes. |
| V3-P07 | "Exceptions only" preset: the phone receives only ask-rule, critical and classifier-denied prompts; everything else stays local. | M | V3-P02 data, platform report | `remotectl config preset exceptions` sets the preset; an integration test feeds 10 mixed hook events and asserts exactly the 3 exception events reach the relay mock. |
| V3-P08 | Go/no-go record for the 3.0 label: evaluate V-G1, V-G2, V-G3, the V3-P04 status and V-K1…V-K7; write the verdict. | S | V3-P01…P04 | `docs/analysis/v3/gates.md` contains `^Verdict: (3\.0|2\.x minors|maintenance)$` and one line per gate with a date. |
| V3-P09 | (Only if V-G2 passes) T2-thin: `remotectl request --wait` + MCP tool `request_approval` returning a signed verdict and a verify command. | M | V3-P03 pass, V3-P04 | `remotectl request --title t --timeout 5s` exits 2 on timeout and 0 on a signed Allow from the test phone key; `remotectl verify <verdict.json>` exits 0 for a valid signature and 1 for one tampered byte. |
| V3-P10 | (Only if V3-P04 is Accepted) Standing rules behind a flag. | L | V3-P04, V3-P07 | With the flag off, no rule path executes (coverage test). With it on: a rule with an expired `exp` is rejected, out-of-scope args are rejected, and every use appends a signed audit line — all three asserted by tests. |

Sizing: S ≤ 0.5 day, M ≤ 2 days, L ≤ 5 days of AI-executor time. Nothing here starts before
the v2 tail is `done` (ROADMAP §0 dependency rule).

## 8. Open questions for the owner (defaults apply until answered)

| # | Question | Default |
|---|---|---|
| Q-V3-1 | Do you accept "no 3.0 label" as the default outcome, with the label gated on V-G1 plus an accepted I1 ADR? | **Yes.** Ship 2.x minors otherwise. |
| Q-V3-2 | May I1 be amended for signed, expiring, scope-bounded standing rules (V3-P04), shipped behind a flag? | **ADR first, flag off by default.** Max expiry 7 d. No learned auto-allow ever. |
| Q-V3-3 | Business model: free hosted relay + sponsorship, with a paid team tier only after ≥3 written commitments? What monthly cost cap for the free relay? | **Yes. No billing code; no self-host licence; cap = current v2 cell cost × 2.** |
| Q-V3-4 | Is T2-thin (signed approval call for scripts/CI) worth building if V-G2 passes, or should it stay out regardless? | Build only on V-G2 pass. |
| Q-V3-5 | Lead positioning claim: "signed, verified, private approvals" replacing "remote control"? | Yes. |
| Q-V3-6 | Should the Deny-only watch mirror be considered for a 3.x minor? | No until ≥3 requests. |

## 9. Sources (all accessed 2026-10-28)

- S1 https://code.claude.com/docs/en/remote-control
- S2 https://code.claude.com/docs/en/changelog
- S3 https://code.claude.com/docs/en/channels
- S4 https://code.claude.com/docs/en/channels-reference
- S5 https://code.claude.com/docs/en/self-hosted-environments
- S6 https://code.claude.com/docs/en/permission-modes
- S7 https://learn.chatgpt.com/docs/remote-connections
- S8 https://learn.chatgpt.com/docs/mobile
- S9 https://openai.com/index/work-with-codex-from-anywhere/
- S10 https://community.openai.com/t/codex-approval-requests-should-trigger-mobile-push-notifications/1381134
- S11 https://cursor.com/docs/cloud-agent
- S12 https://cursor.com/help/ai-features/mobile-app
- S13 https://forum.cursor.com/t/accept-agent-approvals-from-macos-notifications-without-bringing-cursor-to-foreground/164796
- S14 https://github.com/Louis-CFM/coucou
- S15 https://github.com/slopus/happy
- S16 https://apps.apple.com/app/id6748571505
- S17 https://codeongrass.com/blog/grass-vs-cursor/ (vendor blog; weak)
- S18 https://humanlayer.dev
- S19 https://peerpush.com/p/the-handover
- S20 https://enterprisedna.co/directories/open-source/gotohuman
- S21 https://docs.uipath.com/automation-ops/automation-cloud/latest/release-notes/may-2026.md
- S22 https://docs.temporal.io/ai/cookbook/human-in-the-loop-python
- S23 https://codex-container-api-docs.previews.developers.cloudflare.com/agents/concepts/agentic-patterns/human-in-the-loop/index.md
- S24 https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
- Internal: `docs/analysis/v2/reports/01-product.md` §2, §5.1–§5.4, §8; `docs/analysis/reports/01-product.md` (Channels rejection); `docs/analysis/ROADMAP.md` §1.
