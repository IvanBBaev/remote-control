# v2 / 01 — Product & competitive strategy

Role #1 report for `docs/analysis/v2/00-brief.md`. Status: 2026-10-24. Scope: market
delta since the v1 product report (2026-10-12), the v1 kill criterion, a defensible 2.0
positioning, theme verdicts, release scope. Nothing here is a decision.

## 1. Summary

1. **The v1 kill criterion has not triggered.** As of 2026-10-24 Claude Code Remote
   Control (RC) still documents no "Always" from the phone and still supports only Claude
   Code; the changelog 2026-10-14…10-22 is reliability fixes only. M1 is also not done
   (release target `M1 exit`, 88 %, owner-blocked items remain), so the window is still open.
2. **But the market moved on two flanks the v1 report did not price in.** OpenAI Codex now
   has first-party mobile approvals (ChatGPT app, QR pairing, relay, GA per secondary
   sources), and Coucou (6.3k stars) and Happy (24.3k stars, E2E, relay server in repo) are
   multi-agent phone clients. "Many agents in one inbox" and "E2E" are **no longer
   differentiators on their own**.
3. **What is still structurally unclaimed:** (a) people RC and Codex-mobile exclude by
   design: API key, Bedrock/Vertex/Foundry, LLM gateway, ZDR/HIPAA (RC), Codex CLI/IDE
   users (Codex mobile pairs only with the desktop app); (b) a relay that provably never
   holds transcript **and** an agent that verifies a biometric-bound decision itself (I1/I3);
   (c) an audit trail and central policy that need neither of the above vendors' clouds.
4. **Recommended 2.0 positioning:** *"Approvals for coding agents that your vendor's phone
   app cannot reach, with proof, not trust: gateway/API-key/regulated setups, mixed agents,
   per-request signed decisions, an audit trail with no transcript on any server."*
5. **Themes:** ship **T1 Teams-lite (policy + audit + delegate)**, **T3 deterministic smart
   approvals (batch, risk labels, rule suggestions)**, **T4 distribution (TestFlight →
   App Store, signed releases)** and **T6 competitive watch**. Defer **T2** (fleet/jobs;
   only budget guardrails in). Reject for 2.0: native Android, watch/desktop clients,
   self-hosted relay, relay-at-scale work, Gemini-specific investment.
6. **v2 kill/pivot criteria (§4.3)** are machine-checkable: a monthly market-watch script
   plus an adoption floor (≥ 3 external users on the 1.x line 90 days after release, else
   freeze at maintenance).
7. Honest caveat: with one owner and one named second user, **2.0 is justified by users who
   do not exist yet**. The first 2.0 work item is to find them (WP V2-P02), not to build.

## 2. Verified facts

Facts carry a URL. "Secondary" = third-party summary, not an official page; those are
repeated in §3 as assumptions where a decision depends on them.

### 2.1 Claude Code Remote Control (official docs, fetched 2026-10-24)

- F1. RC requires a claude.ai subscription: "available on Pro, Max, Team, and Enterprise
  plans. API keys are not supported." Team/Enterprise: an Owner must enable it. —
  https://code.claude.com/docs/en/remote-control
- F2. RC is unavailable on Bedrock, Google Cloud Agent Platform (Vertex), Microsoft
  Foundry, with `ANTHROPIC_BASE_URL` pointing away from `api.anthropic.com` (LLM gateway
  or proxy), or behind an enterprise Claude apps gateway. Errors: "Remote Control requires
  claude.ai subscription auth." — same URL.
- F3. "While Remote Control is connected, the session transcript, including your messages,
  Claude's responses, and tool activity, is stored on Anthropic servers." ZDR orgs and the
  HIPAA configuration have RC off. — same URL.
- F4. Trusted Devices is a beta: device enrollment, biometric/passkey step-up (Face ID,
  Touch ID, Windows Hello), sign-in ≤ 18 h old; Pro/Max users can turn it on themselves,
  Team/Enterprise via org setting. — same URL.
- F5. Push is two toggles only, "Push when Claude decides" and "Push when actions
  required"; "there is no per-event configuration" beyond them. — same URL.
- F6. A fetch of the RC page contains no "always allow" rule creation from the phone and
  no agent other than Claude Code (grep over the saved page for "always" returned no
  phone-side rule feature). Absence, not a proof of absence — same URL.
- F7. Changelog since 2026-10-12 touching RC: 2.1.299 (Oct 14) queued-prompt loss fix;
  2.1.300 (Oct 14) `--sandbox/--no-sandbox` flags removed from `claude remote-control`,
  diff view fix, "sessions whose computer can't be reached still appearing to accept
  messages" fixed; 2.1.302 (Oct 16) subagent pane shows RC disconnected; 2.1.304 (Oct 19)
  history fix when a different account is signed in; 2.1.305 (Oct 20) spawn-mode messages,
  `w` saves mode per folder; 2.1.307 (Oct 21) faster connect with large images/PDFs. None
  adds Always or another agent. — https://code.claude.com/docs/en/changelog
- F8. Anthropic is widening *approval surfaces* beyond RC: Claude Tag (Slack) got a
  private Allow once / Deny card for connector actions (2.1.300, Oct 14) and an
  Allow/Deny bug fix (2.1.309, Oct 22); `PermissionRequest` hooks are explicitly ignored
  for `setMode` and for shell/subagent approval in Cowork cloud auto mode (2.1.299/2.1.300).
  — https://code.claude.com/docs/en/changelog
- F9. Mods API: `decider: "person"` for `tool.check` — "Only the permission dialog or a
  host callback can approve the ask" (2.1.304); `claude_code.safety_event` OTel events per
  stopped/prompted tool call (2.1.307). Signals that Anthropic is hardening *who* may
  approve. — same changelog.
- F10. `claude -p` and SDK sessions on third-party providers now start in `default`
  permission mode (2.1.302). — same changelog. (Relevant to claude-sdk adapter users.)
- F11. RC now syncs subagent and "dynamic workflow" progress across devices, supports
  attaching photos/files from the phone. — https://code.claude.com/docs/en/remote-control

### 2.2 Coucou (https://github.com/Louis-CFM/coucou, fetched 2026-10-24)

- F12. 6.3k stars (v1 report: 4,935 on 2026-10-12: about +28 % in 12 days), 773 commits.
  Releases 2026-10-22: macOS/Windows/Linux 0.5.3, Android 0.3.0. Code MIT; name, character
  and sounds proprietary.
- F13. Agents: Claude Code, Cursor, Codex, Gemini CLI, Antigravity, Copilot CLI, Muse Code,
  OpenCode, Amp, Hermes, Claude Desktop, plus `--agent <name>`.
- F14. iPhone (iOS 18+, TestFlight beta): Live Activities/Dynamic Island, Allow/Deny from
  notifications, Face ID on every Allow, chat/instructions, widgets, Siri/Shortcuts,
  iCloud (CloudKit) sync. Android: fingerprint-protected Allow, answers, chat, overlay,
  tile, nine widgets; phone link off by default; **requires same Wi-Fi** and Coucou ≥ 0.4.0
  on Windows or Linux (not Mac). Recent themes: experimental WhatsApp replies, one-click
  updates, offline dictation.
- F15. Relay is a stateless Cloudflare Worker holding the APNs key; "only sees the agent's
  name and state."

### 2.3 OpenAI Codex mobile

- F16. Preview announced 2026-05-14: Codex inside the ChatGPT iOS/Android apps; approve
  commands, review output, switch models, start work on a machine running Codex; QR pairing;
  "secure relay layer"; macOS first, Windows "coming". —
  https://9to5mac.com/2026/05/14/openai-brings-codex-control-to-chatgpt-for-iphone-and-android/
- F17. Current official page: the host must run the ChatGPT desktop app on macOS or
  Windows, awake, online and signed into the same account/workspace; "You can't set it up
  from the Codex CLI or IDE extension"; Linux is not a remote-access host; from the phone
  you can approve commands, answer questions and steer; workspace admins may need to enable
  Remote Control; the page does not cover API-key auth. —
  https://learn.chatgpt.com/docs/remote-connections (redirect of
  https://developers.openai.com/codex/remote-connections)

### 2.4 Others

- F18. Happy (slopus/happy): 24.3k stars, 3,572 commits, MIT, "end-to-end encrypted mobile
  app", relay server package + Dockerfile in repo; named agents Claude, Codex (page also
  lists inconsistent names); approvals not described on the repo page. —
  https://github.com/slopus/happy (self-claimed security; not audited by us)
- F19. Gemini CLI was replaced by Antigravity CLI: Gemini CLI and Code Assist IDE
  extensions stop serving Pro/Ultra/free-individual users on 2026-06-18; enterprises and
  paid Gemini API-key users keep Gemini CLI access; Antigravity CLI "won't have feature
  parity at launch". —
  https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/ ;
  https://virtualizationreview.com/articles/2026/05/19/google-moves-gemini-cli-into-antigravity-cli-as-agent-platform-expands.aspx
- F20. Searches found no official mobile-approval product for Gemini CLI/Antigravity,
  Cursor (mobile/web agents exist; approvals unconfirmed) or GitHub Copilot coding agent
  (asynchronous PR model) as of this date. A notch-style Mac app added Cursor/Gemini/
  Copilot CLI support on 2026-10-20 with approvals staying in each agent's own prompt —
  https://github.com/MANISH007700/notch-island/pull/4 (single PR, weak evidence).

## 3. Assumptions

- A1. M1 is not done: ROADMAP progress block (updated 2026-10-17) lists domain/Railway,
  device spike, npm publication, named second user, two weeks of use as open. If the owner
  has since closed M1, the kill-criterion window has closed and K1 below is the live test.
- A2. Codex Remote reached GA around June–July 2026 and moved to per-device-per-host QR
  pairing (secondary: https://codex.danielvaughan.com/2026/07/10/codex-remote-ga-qr-relay-architecture-mobile-approvals-ssh-host-cli-developer-guide/
  and https://www.gradually.ai/changelogs/codex-app/). Not verified on an official page.
- A3. A September 2026 summary says RC took "start a session from the phone" out of
  research preview with a device card in the Claude app's Code tab (secondary:
  https://aicatchup.com/news/claude-code-remote-control-phone-start). v1 reason (e) is
  therefore weaker than the v1 report assumed; treat as likely true.
- A4. The population of "Claude Code on API key / Bedrock / gateway / ZDR" and "Codex CLI
  only" developers is large enough to matter for a free tool; there is no data in this
  report. Employer-managed setups (gateways, Bedrock) are common in enterprise but those
  users also face employer approval for installing anything.
- A5. Anthropic will not add API-key/Bedrock/gateway support to RC soon: F3 (server-side
  transcript) is architectural. Reasoned, not announced.
- A6. Antigravity CLI exposes no `PermissionRequest`-class hook comparable to Claude Code's
  (not checked; role 4 should). If it does, it is the only Gemini-lineage target worth an
  adapter.
- A7. Coucou's Android LAN-only limit and iPhone iCloud limit are still its internet
  story (F14, F15); a hosted zero-deploy relay for Android remains absent from it.
  Relay doc re-check was not repeated this session beyond F15.
- A8. The owner remains the only executor; 2.0 scope must fit roughly the size of v1's
  M2+M3 (tens of Opus-hours), not another M0-sized build.

## 4. Findings

### 4.1 Kill criterion status

v1 text (ROADMAP §1): "if Anthropic ships 'Always' from the phone plus a non-Claude agent
in Remote Control before M1 is done, stop and use Remote Control." Evidence on 2026-10-24:
F6 (no Always), F1/F7 (no other agent), A1 (M1 open). **Not triggered.**

Side finding: the criterion was *too narrow*. It watches only Anthropic and only two
features. Meanwhile the user-visible threat came from OpenAI (F16–F17) and from free
multi-agent clients (F12–F18). None of these hits the original wording, yet they erode
reasons (a), (c) and (e). The criterion needs a v2 counterpart (§5.3).

### 4.2 What each v1 reason is worth now

| v1 reason | State 2026-10-24 | Verdict |
|---|---|---|
| (a) one inbox, several agents | Coucou covers 10+ agents, Happy Claude+Codex, Codex has first-party mobile | **Weak** alone; still true for *approvals with E2E binding* |
| (b) API key / Bedrock / Vertex / gateway / ZDR | RC excludes all (F1–F3); Codex page silent on API keys (F17) | **Strong, structural** |
| (c) privacy / metadata-only relay | RC stores transcript (F3); Coucou relay sees only name+state (F15) but iPhone is iCloud-bound; Happy E2E (F18, self-claimed) | **Medium**: differentiator is *verified* (agent checks assertion) not E2E per se |
| (d) "Always" from phone | Still undocumented in RC (F6); Coucou has it for Claude Code | **Medium**, time-limited; copyable by Anthropic in one release |
| (e) start session in any allow-listed repo | RC has per-folder and device-card start (A3) | **Weak** |
| (f) per-project history and cost | Not in RC; Coucou has usage capability | **Medium**, and it is the seed of T2 guardrails |
| new: Codex CLI/IDE users | Codex mobile needs desktop app, no CLI host (F17) | **Strong**, if the Codex adapter works against the CLI |
| new: verified approvals / audit trail | Nobody ships signed per-request decisions with exportable audit | **Open ground** (T1) |

### 4.3 The v2 shape that follows

The defensible core is not "a nicer phone app" (Coucou and the vendors win that race with
more resources) but **the trust architecture v1 already built**: per-request WebAuthn
assertion, agent-side verification, relay holds no plaintext or authority, decisions
dropped not queued. v2.0 should *productise that into a policy and audit surface* and
*widen the population who can use it*.

Concretely, teams are the one theme where the invariants are a feature: central policy is
safe only because the agent verifies it (I1), and an audit log is valuable only if the
relay cannot read it (I3). A vendor with server-side transcripts (RC, Codex cloud relay)
cannot offer "audit without transcript".

## 5. Recommendations

### 5.1 Positioning (2.0)

> **Verified approvals for coding agents your vendor's phone app does not cover.**
> Every Allow is a biometric-signed decision bound to one request and checked on your
> machine. Works with API keys, gateways, Bedrock/Vertex, Codex CLI and mixed agents.
> No transcript on any server, with an audit trail you can export.

Target order: (1) the owner and the named second user; (2) developers on gateway/Bedrock/
API-key setups; (3) Codex CLI users; (4) small teams (2–10 humans) who want
"two-person approval for production-adjacent repos" and an audit export; (5) privacy-
sensitive solo developers. Not targeted: Claude Pro/Max-only solo developers (RC wins;
keep the README comparison table, update it with Codex and Coucou/Happy rows).

Rejected positioning alternatives:
- *"Open-source Coucou for Android/web."* Rejected: Coucou is MIT, moving 0.5.x/week,
  and already ships Android; we would be a smaller clone.
- *"Universal agent remote (chat, start, steer anything)."* Rejected: RC and Codex mobile
  own that, with first-party model access.
- *"Enterprise compliance product."* Rejected for 2.0: no SSO, SOC2 or procurement path
  for one developer; T1 stays "teams-lite".

### 5.2 Theme verdicts

| # | Theme (brief §) | Verdict | Reason |
|---|---|---|---|
| 1 | Teams, delegation, audit, central allow-list, quorum | **IN, scoped to teams-lite** | The only theme that turns I1/I3 into a moat (§4.3). Scope: ≤ 10 humans per machine group, signed policy bundle pushed to the agent, 2-of-N approval for rules marked `quorum`, delegate-for-N-hours, audit export (JSONL, hash-chained, no payloads). No SSO/SCIM. |
| 2 | Agent breadth, fleet, long-running jobs, scheduling, budgets | **PARTIAL**: budget guardrails + fleet list only | Per-session/day cost counters exist (v1 M2). A guardrail ("deny + notify above $X/day, from agent-side counters") is cheap and RC lacks it. Scheduling/autonomous jobs rejected: Claude Code `/loop`, Cowork schedules and cloud agents cover it, and it moves toward I1 risk. |
| 3 | Smarter approvals | **IN, deterministic only** | Batch approve (same tool + same scope, one assertion over N request ids), risk labels from a fixed rule table (path outside repo, `rm`, network, secrets path), "suggest a rule from history" shown as a proposal the human signs. No ML scoring, no auto-allow learned silently (breaks I1). Summaries only on-device or from the agent's own summary field, never relay-side (I3). |
| 4 | Distribution | **IN: iOS TestFlight → App Store, signed releases, release checklist**; **OUT: Android native, watch, desktop shell** | M4 native app exists; App Store review is the real gate. Android stays PWA (Q6 floor). Watch has no demand evidence. Self-host/hosted pricing: see Q-P3, default "hosted free tier, no self-host" (ROADMAP "Never": user-deployed relay). |
| 5 | Relay at scale | **OUT** except a published abuse/cost budget | 2 replicas (v1) is far above any plausible 2.0 load. Add only per-account rate limits and a cost-per-user number to docs. |
| 6 | Competitive reality | **IN** | §5.3. |
| new | Adapter hardening | **IN**: Codex CLI real-device parity; claude-sdk for gateway users; **Gemini-lineage frozen** until A6 is checked | Gateway/API-key users are the strongest wedge (§4.2), and Gemini CLI is retired for consumers (F19). |

Rejected whole-theme alternatives:
- *Fleet/agent-to-agent dashboard as the headline.* Rejected: agenthropic in this same
  workspace already targets observability, and nothing here needs it to hold approvals.
- *Android native first.* Rejected: Coucou Android exists (F14) but is LAN-bound; our PWA
  + relay already cover Android internet use. Revisit only if PWA push on Android proves
  unreliable in the v1 device spike.
- *Pricing/billing in 2.0.* Rejected: zero users to bill; revisit with Q-P3.

### 5.3 v2 kill / pivot criteria (counterpart to ROADMAP §1)

Evaluated monthly by `tools/market-watch` (WP V2-P01) and recorded in
`docs/verification/market-watch.md`:

- **K1 (vendor closes the wedge):** RC docs gain API key *or* Bedrock/Vertex *or* gateway
  support **and** "always allow" from the phone → stop 2.0 feature work, keep the
  `remotectl` agent in maintenance for Codex/mixed-agent users only.
- **K2 (Codex closes the wedge):** the Codex remote page lists CLI/IDE as host **or**
  states API-key auth works for mobile control → drop the Codex adapter's marketing, keep
  it as a technical feature.
- **K3 (free competitor adds our moat):** Coucou or Happy ships agent-verified,
  biometric-bound, per-request signed decisions and an exportable audit trail → fold T1
  into a "compat" mode or stop T1.
- **K4 (nobody comes):** 90 days after 1.0 tagged, fewer than 3 external humans with ≥ 5
  approvals each in relay metadata counters → freeze at maintenance; no T1/T3 build.
- **K5 (regulatory/store):** App Store rejects the native app twice on the same guideline
  → ship PWA-only 2.0.

### 5.4 Release scope: 2.0 versus 1.x

Order (dependency-driven):
1. **1.x (now):** finish M1 exit and M4 TestFlight; run V2-P02 interviews in parallel.
2. **2.0-alpha:** T4 release hygiene (signed builds, store listing), T3 batch + risk labels
   (smallest, visible value, no schema change beyond a `batch` message).
3. **2.0-beta:** T1 policy bundle + audit export, delegate; budget guardrail.
4. **2.0:** quorum approvals only if V2-P02 finds a real team; otherwise ship 2.0 without
   quorum and call it 2.0 because of signed policy + audit + batch + App Store.

Major-version justification: a protocol bump (policy bundle, batch decision) and the
audit format are breaking relay/agent changes; per Q21 the relay supports current +
previous major, so 2.0 agents and 1.x agents coexist.

Cut line if time runs out: ship T4 + T3 as 1.x minors, call nothing 2.0. A major version
without teams-lite is marketing, not substance.

## 6. Risks

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| R1 | No external users: positioning (b) is based on assumption A4 | High | V2-P02 first; K4 |
| R2 | Anthropic or OpenAI ships the wedge features in one release (F3 could change if transcripts move client-side) | Medium | Monthly watch; keep v1 architecture useful for mixed agents; K1/K2 |
| R3 | Secondary-source facts (A2, A3) are wrong | Medium | Re-verify on official pages in V2-P01 before the README table is updated |
| R4 | Claude Code hook surface changes (F8: PermissionRequest hooks already ignored in some modes) | Medium | Version-gated conformance run (exists in v1), pin tested versions |
| R5 | Agent-side policy bundle becomes a remote-code-ish vector | Low/High impact | Signed bundle, data only (no scripts), owner-device signature, I1 maintained; ADR before build |
| R6 | App Store review friction / $99 enrolment already needed (Q22) | Medium | TestFlight first; PWA fallback stays (ADR 0017) |
| R7 | Scope creep from "teams" toward SSO/billing | Medium | Hard cap ≤ 10 humans; no accounts beyond passkeys + invite (Q4) |
| R8 | Coucou/Happy copy our verified-decision design | Medium | K3; keep spec and test vectors public to be the reference |

## 7. Work items

Sizes follow ROADMAP calibration (S = 1 h, M = 2 h, L = 4 h Opus 5.5). All ACs are
runnable by CI or a script.

| ID | Item | Size | Deps | Acceptance (machine-checkable) |
|---|---|---|---|---|
| V2-P01 | `tools/market-watch`: fetches the RC, Codex remote, Coucou and Happy pages, greps for K1–K3 strings, writes dated rows to `docs/verification/market-watch.md` | M | none | `pnpm tsx tools/market-watch --dry-run` exits 0 and prints one verdict line per K1, K2, K3; unit test with saved fixtures asserts each K flips on a seeded string |
| V2-P02 | Demand evidence: 5 structured interviews or public-thread analyses of gateway/Bedrock/API-key and Codex-CLI users; results in `docs/analysis/v2/demand.md` | M | none | File exists with ≥ 5 dated rows, each with a source URL or interview id and a yes/no on "would install"; K4 baseline number written |
| V2-P03 | README comparison table refresh: RC, Codex mobile, Coucou, Happy rows with dated citations | S | V2-P01 | `grep -c 'Codex' README.md` ≥ 1 in the table; every row cell has a URL; docs-link check script passes |
| V2-P04 | ADR "v2 positioning and kill criteria" in `docs/adr/` recording §5.1 and §5.3 | S | owner Q-P1 | File exists with Status field; ROADMAP §1 kill-criterion paragraph links it |
| V2-P05 | Batch approval: protocol message `batch_decision`, relay passthrough, PWA/native UI, agent applies only to ids it holds | L | M1 done | Journey test: 3 pending identical-scope requests approved by 1 assertion; a 4th request arriving later is NOT approved; privacy gate green |
| V2-P06 | Deterministic risk labels table + tests; label shown on card; label text not computed by relay | M | none | Table-driven unit test ≥ 25 cases; relay package has no import of the label module (dep-cruiser rule) |
| V2-P07 | Rule suggestion from agent-side history shown as proposal; human signs an Always | M | Q7 settings scopes | Test: suggestion never applied without an assertion; privacy gate shows no rule text at the relay |
| V2-P08 | Signed policy bundle (allow/deny/quorum rules) pushed to agent; data-only schema; ADR first | L | V2-P04 | Agent rejects unsigned/old-version/tampered bundle (3 tests); bundle with script field rejected by schema |
| V2-P09 | Delegate-for-N-hours (second paired human, time-boxed), revocable | M | V2-P08 | Test: delegate decision accepted before expiry, refused after; revoke takes effect on next request |
| V2-P10 | Audit export: hash-chained JSONL of decisions (request id, tool label, hash of input, decider, time), no payloads | M | none | `remotectl audit export` output verifies with `remotectl audit verify`; flipping one byte fails verification; privacy gate green |
| V2-P11 | Quorum 2-of-N approval for rules marked `quorum` (build only if V2-P02 shows a team) | L | V2-P08, V2-P09 | Test: one assertion leaves request pending; second distinct human releases it; same human twice does not |
| V2-P12 | Budget guardrail: agent-side daily cost counter, deny + notify above threshold | M | M2 cost counters | Test with fake Claude Code: request after threshold is denied with reason `budget`; counter never leaves the agent unencrypted |
| V2-P13 | Gateway/API-key path hardening: claude-sdk adapter documented and verified with a base URL override | M | M3 claude-sdk | Journey run against fake gateway passes; README "no Remote Control needed" section exists |
| V2-P14 | Codex CLI parity run on a real device and real Codex CLI; log | S | M2 Codex | `docs/verification/codex-real.md` records version and a held approval |
| V2-P15 | App Store submission package (listing, privacy labels, review notes) | M | M4, Q22 | Checklist file complete; privacy label text matches the privacy gate output |
| V2-P16 | Check Antigravity CLI hook surface (read-only research) and decide adapter go/no-go | S | none | `docs/analysis/v2/antigravity.md` states hook/permission mechanism with URL, or "none" |

Suggested execution: P01, P02, P04, P16 first (cheap, de-risk); then P05, P06, P10, P15;
P08/P09 after owner ratifies; P11 conditional.

## 8. Open questions for the owner (with defaults)

| # | Question | Default |
|---|---|---|
| Q-P1 | Ratify the 2.0 positioning (§5.1) and the K1–K5 criteria (§5.3) | **Yes**; ADR per V2-P04 |
| Q-P2 | Is 2.0 allowed to be "T3 + T4 only" if V2-P02 finds no team demand (cut line §5.4)? | **Yes**: ship as 1.x minors, no 2.0 label |
| Q-P3 | Hosting/pricing model: free hosted relay with per-account limits, no paid tier, no self-host | **Yes**; revisit after K4 is evaluated |
| Q-P4 | Teams cap and scope (≤ 10 humans, no SSO) | **Yes** |
| Q-P5 | Who can be the first external users for V2-P02 (names or communities)? | Owner names ≥ 3 candidates; default: ServiceNow/Nuvolo colleagues on gateway or Bedrock setups (assumption, owner knows better) |
| Q-P6 | Gemini/Antigravity: stay frozen until V2-P16 | **Yes** |
| Q-P7 | Is Windows/Linux agent parity required for 2.0 given Codex mobile is Mac/Windows only? | **Linux and macOS required, Windows best-effort** (v1 Q14 posture) |
| Q-P8 | Does the owner want K4's 90-day adoption floor to trigger an automatic freeze, or just a review? | **Review**, owner decides |

## 9. Sources

Official / primary
- https://code.claude.com/docs/en/remote-control — F1–F6, F11
- https://code.claude.com/docs/en/changelog — F7–F10 (entries 2.1.299–2.1.309, 2026-10-14…10-22)
- https://learn.chatgpt.com/docs/remote-connections (from https://developers.openai.com/codex/remote-connections) — F17
- https://github.com/Louis-CFM/coucou — F12–F15
- https://github.com/slopus/happy — F18
- https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/ — F19

Secondary (used as facts only where marked, otherwise assumptions)
- https://9to5mac.com/2026/05/14/openai-brings-codex-control-to-chatgpt-for-iphone-and-android/ — F16
- https://www.macrumors.com/2026/05/15/openai-brings-codex-chatgpt-mobile-app/
- https://codex.danielvaughan.com/2026/07/10/codex-remote-ga-qr-relay-architecture-mobile-approvals-ssh-host-cli-developer-guide/ — A2
- https://www.gradually.ai/changelogs/codex-app/ — A2
- https://aicatchup.com/news/claude-code-remote-control-phone-start — A3
- https://virtualizationreview.com/articles/2026/05/19/google-moves-gemini-cli-into-antigravity-cli-as-agent-platform-expands.aspx — F19
- https://github.com/MANISH007700/notch-island/pull/4 — F20
- https://codepick.dev/en/guides/mobile-ai-coding-tools-2026/ — landscape roundup (not relied on)

Internal
- `docs/analysis/ROADMAP.md` §1–3, §6, progress block (2026-10-17)
- `docs/analysis/reports/01-product.md` (v1, 2026-10-12)
