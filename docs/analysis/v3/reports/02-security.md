# v3 / 02 — Security architecture (standing rules and I1, approval API, cloud agents, org identity, attestation, new clients)

Role: Security architect. Status: 2026-10-28. Inputs: `v3/00-brief.md`, `v2/SYNTHESIS.md`,
`v2/ROADMAP-v2.md`, `v2/reports/02-security.md` (cited as v2-§ / v2 W-S#), ROADMAP §1 (I1–I4),
D3, D7, D8, D24, D25, ADR 0010, 0016, 0017. Nothing here is a decision. Code was not re-read
except one grep (§4.5); implementation statements come from ADR/ROADMAP text.

## 1. Summary

1. **Amend I1, narrowly** (§5.1): a *standing rule* is a decision whose object is a rule, signed with the same UV signature as an Allow, matched deterministically on structured fields, bounded in time and uses. "Always" at session scope (D24) is already one. The agent still never grants without a human signature in the causal chain; "learned policy" only *proposes* rules.
2. **One law for every new surface:** *an approval is worth only what its enforcement point is worth.* Every 3.0 feature must name the component that checks the device signature and holds the credential that acts. If that component is the requester itself (an MCP tool returning "approved" to the agent that asked), the approval is **advisory UX, not security**, and must be labelled so.
3. **External approval API = "every requester is a paired verifier"**: no relay endpoint accepts approval requests. CI and generic agents go through a `remotectl` instance (local or an org *gate agent*), which verifies workload identity (OIDC), shows only verified fields, checks the device signature and itself holds the deploy/merge credential. Relay keeps I1/I3.
4. **Cloud/background agents** (Claude Code on the web, self-hosted runners): approvals are sound only when the verifier and its pinned keys come from a source the session cannot write — server-managed settings or the runner image — never the repo's `.claude/settings.json`, which is part of the agent-writable clone. Codex cloud has no per-action approval point; gate its PR/merge instead.
5. **Card phishing is the top new threat** once requesters are arbitrary: render from parsed tool input, demote model-authored text ("agent says"), refuse/flag bidi and invisible characters, show verified requester identity, never requester-chosen titles.
6. **Organisation grade only on branch A**: SSO/SCIM may *narrow or veto* (deprovision, group filter), never add a principal or grant; authority stays in `peers.json`. Compliance = signed export of the v2 hash-chained audit, not a certification claim.
7. **Not in 3.0**: self-host relay (design the push-gateway contract only), App Attest/Play Integrity verification on the agent, Slack/Teams/watch Allow, LLM-scored auto-allow, any relay-side policy evaluation.

## 2. Verified facts

- F1. MCP 2025-11-25 elicitation has *form* and *url* modes; servers MUST NOT request secrets via form mode; clients MUST show which server is asking; servers MUST bind elicitation to client and user identity; "Servers MUST NOT rely on client-provided user identification"; a phishing section describes attacker-forwarded URLs and requires same-user checks; URL mode is marked as subject to change — https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
- F2. OpenID CIBA separates a *consumption device* (initiates) from an *authentication device* (user authenticates and consents); `binding_message` is shown on both so the user can match requests; optional `user_code` exists to stop unsolicited flows; clients MUST authenticate to the backchannel endpoint; modes poll/ping/push — https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html
- F3. RFC 9396 (OAuth 2.0 Rich Authorization Requests) adds `authorization_details` for fine-grained authorization data (e.g. amount, specific resource) — https://www.rfc-editor.org/rfc/rfc9396.html
- F4. Claude Code hooks: `PermissionRequest` decides via `hookSpecificOutput.decision.behavior` allow/deny; hook types include `command`, `http`, `mcp_tool` with default timeout 600 s; hooks fire in cloud sessions with `CLAUDE_CODE_REMOTE=true`; cloud sessions do not read the user's `~/.claude/settings.json`; `allowManagedHooksOnly` blocks user/project/local/plugin hooks — https://code.claude.com/docs/en/hooks
- F5. Claude Code cloud environments: network levels None/Trusted/Full/Custom; the repo's `.claude/settings.json` hooks and permission rules apply in single-repo cloud sessions as "part of the clone"; server-managed settings are fetched from Anthropic at session start; MDM/managed files do not apply on Anthropic VMs; self-hosted environments also read hooks seeded from the runner host and the runner image's managed settings — https://code.claude.com/docs/en/cloud-environments
- F6. Self-hosted environments (public beta, Team/Enterprise) run cloud sessions on customer runners; per-session `CLAUDE_CONFIG_DIR` is written from a snapshot of the runner host config; repo `.mcp.json` servers are auto-approved in cloud sessions — https://code.claude.com/docs/en/self-hosted-environments-configuration
- F7. Claude Code *auto mode*: a classifier model reviews actions instead of the user; blocks e.g. `curl | bash`, force push, production deploys; pauses after 3 consecutive / 20 total blocks; "does not guarantee safety"; admins disable it with managed `permissions.disableAutoMode: "disable"` — https://code.claude.com/docs/en/permission-modes
- F8. Codex: agent runs without network access by default, locally and in the cloud; cloud setup phase may reach the internet and secrets are removed before the agent phase — https://developers.openai.com/codex/security (cloud per-action approval behaviour not found in primary docs; see A6)
- F9. GitHub custom deployment protection rules: a GitHub App receives `deployment_protection_rule`, authenticates as the app, and POSTs `state: approved|rejected`; up to 10 status updates; incompatible with `deployment: false` — https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/create-custom-protection-rules
- F10. GitHub Actions OIDC: issuer `https://token.actions.githubusercontent.com`, claims include `sub`, `repository`, `ref`, `workflow`, `job_workflow_ref`, `environment`, `run_id`; a token is unique per job; repos created after 2026-07-15 get an immutable `sub` with owner/repo ids — https://docs.github.com/en/actions/concepts/security/openid-connect
- F11. Play Integrity standard requests bind a token to a request via `requestHash` (≤ 500 bytes); verdicts must be decrypted on Google's servers (`decodeIntegrityToken`); repeated decryption clears verdicts — https://developer.android.com/google/play/integrity/standard
- F12. Slack signs requests with an app-wide HMAC signing secret and a timestamp (5-minute replay window); the signature proves the request came from Slack — https://docs.slack.dev/authentication/verifying-requests-from-slack
- F13. SCIM 2.0 is HTTP provisioning of Users/Groups (POST/PUT/PATCH/DELETE) relying on TLS and standard HTTP auth (bearer + OAuth) — https://datatracker.ietf.org/doc/html/rfc7644
- F14. OWASP LLM01:2025 defines indirect prompt injection (input from external sources) and lists "require human approval for high-risk actions" and "segregate and identify external content" as mitigations — https://genai.owasp.org/llmrisk/llm01-prompt-injection/
- F15. Trojan Source: Unicode bidi controls reorder displayed text vs logical order (CVE-2021-42574); homoglyph variant CVE-2021-42694 — https://trojansource.codes/
- F16. CryptoKit `SecureEnclave.P256.Signing.PrivateKey` with access control/`LAContext` is listed as available on watchOS 9+ — https://developer.apple.com/documentation/cryptokit/secureenclave/p256 (index page; detail via search snippet). Apple Watch locks when removed from the wrist (wrist detection) — https://support.apple.com/guide/security/secc7d85209d/web
- Re-used, not re-verified: Android Key attestation chain and per-use biometric keys (v2-§2 V1); hooks run with full user permissions, `Bash` content rules bypassable (v2-§2 V2); Secure Enclave key per decision (ADR 0017).

## 3. Assumptions

- A1. App Attest attests a per-install app key with an Apple-rooted chain and counters; it says nothing about the *user*. Apple's page did not render again (https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server) — still v2 A2.
- A2. Apple Watch has no Face ID/Touch ID; user verification on watch = passcode at wear time + wrist detection, so a per-signature biometric (ADR 0017 "biometry, current set") cannot exist on the watch.
- A3. In an Anthropic-hosted cloud session the agent (Claude) can write any file in the VM, including scripts a hook would execute, unless they are outside its writable paths; the server-managed hook *definition* is not agent-writable, but the binary it calls may be.
- A4. Claude Code's Bash tool input carries a model-authored `description`; MCP tools carry server-authored descriptions. Both are attacker-influenced under injection.
- A5. Org customers on branch A want SSO for relay sign-in and offboarding, not for per-decision authentication; device keys remain the decision factor.
- A6. Codex cloud tasks run to completion in a sandbox and deliver a diff/PR; there is no per-tool-call hook we can attach to.
- A7. A self-hosted relay cannot send APNs pushes for our App Store app without our team's `.p8` key, so self-host needs a push gateway we operate.

## 4. Findings

### 4.1 Threat-model delta for 3.0

| New actor / asset | Why new | Section |
|---|---|---|
| Arbitrary requester (CI job, generic agent, MCP server) | v1/v2 requester was always our own hook on a paired machine | 4.4 |
| Requester-authored card text | Becomes the phishing channel against the approver | 4.5 |
| Cloud VM verifier | Verifier runs on a host where the agent has the same privileges | 4.6 |
| Deploy/merge credentials held by a gate agent | High-value; whoever holds them is the real authority | 4.7 |
| Standing rule store | Pre-authorised decisions that outlive attention | 4.2 |
| IdP/SCIM | A third party that can assert membership | 4.8 |
| Push gateway for self-host | Sees device tokens and timing for foreign relays | 4.11 |

The v2 ceiling is unchanged (v2-§4.1): the local account or a prompt-injected session on the agent host can do anything the user can. 3.0 must not market protection against it.

### 4.2 Standing rules and the I1 amendment

v2 already designed the rule shape, matcher limits and bounds (v2-§4.9, §5.7; W-S11). 3.0 adds three things.

**Why amend now, not keep deferring.** Friction is the product's main churn risk, and the vendor answer is a *classifier* that grants (F7). That is exactly what I1 forbids us. Without a human-signed alternative, users who want fewer prompts leave for auto mode. A signed, bounded rule is the differentiator: "fewer prompts, and every grant still traces to your Face ID".

**What is new vs v2:**
- *Rule = decision kind.* `rule_create` goes through the full D7 check list (KK, fresh, peer, UV signature over the canonical rule) and the ADR 0010/0017 agent-side verification. A rule is also bound to `agent_device_id` and a `scope_root` realpath, so it cannot be replayed to another machine or repo.
- *Use-time re-verification.* At every match the agent re-verifies the stored signature against the pinned peer key and checks the peer is still active (lease, v2 Q-S5). A revoked or replaced device kills its rules. This makes tampering with the rule file by anything except the local account detectable, and ties rules to device lifecycle (v2 W-S8).
- *Rules never cover:* `instruct`, `start`, `enroll`, `delegate`, `rule_create` itself, policy changes, writes into `.git`/`.claude`/agent config, any request with risk ≥ high (v2 W-S10), any class a quorum policy covers (branch A), and **any request from an external requester** (§4.4) unless the rule names that requester's verified identity.
- *Visible use.* Every rule hit emits a `resolved` event with `by: rule_id` to all phones (D25 fan-out) and an audit entry (v2 W-S5); the phone shows "auto-approved by rule X (n/50 left)" in history and Live Activity count, so silent auto-allow cannot exist.
- *Interaction with Claude Code rules.* Do not write rules into Claude Code `permissions.allow`: those are files the agent can edit and use bypassable string matchers for `Bash` (v2-§2 V2). Keep rules in `remotectl` state, evaluated inside our `PermissionRequest` hook, so Claude Code still asks and our hook answers.

**Approve by exception** = rules + risk labels: low-risk structured calls inside a rule pass silently; everything else is a card. This is the 3.0 headline UX without moving authority.

### 4.3 Policy learned from audit history

Allowed: deterministic agent-side counters over the local audit log ("you approved `Edit` under `src/` 14 times in 2 days, never denied") producing **rule proposals** that the human signs. Forbidden: automatic promotion, widening an existing rule on its own (e.g. extending `not_after` or `max_uses`), proposals computed by an LLM or off-machine (I3, v2-§4.9). Proposals are themselves an attack surface: an injected agent can *farm* approvals of a benign command to get a broad rule proposed. Mitigations: proposals only for structured tools or exact `Bash` hashes (never generalise a shell string), proposals never broader than the union of what was approved, default lifetime 24 h, and a "proposal" is shown with the evidence list.

### 4.4 External approval API / MCP human-in-the-loop

Candidate shapes and their enforcement points:

| Shape | Who enforces | Verdict |
|---|---|---|
| A. MCP server tool `request_approval(summary)` returning approved/denied to the calling agent | The calling agent itself | **Advisory only.** An injected or buggy agent ignores "denied" or never asks. Fine as UX ("ask me"), must never be sold as a control |
| B. MCP elicitation surfaced on the phone | The MCP client/host | Same as A unless the host is our hook; elicitation's identity rules (F1) bind to the MCP user, not a device key |
| C. Requester → relay HTTP API → phone | Relay | **Rejected:** relay would see request content (I3) and be the issuer of authority (I1) |
| D. Requester → `remotectl` (localhost socket or org gate agent) → phone → `remotectl` verifies → `remotectl` performs or releases the action with a credential the requester does not hold | `remotectl` | **Recommended.** Same trust shape as the hook path |
| E. Signed approval token returned to the requester and verified by the resource server (CIBA/RAR-like, F2/F3) | Resource server holding pinned device keys | Sound, but needs integrations per resource server; v3.x for one target only (deploy gate, §4.7) |

**Requester authenticity.** For D the gate agent authenticates the requester: local callers by Unix socket peer credentials and a per-client token minted by `remotectl clients add` at the terminal; CI by OIDC (F10) verified against a pinned issuer and an allow-list of `repository`/`job_workflow_ref`/`environment`. The card shows only *verified* claims as identity. A requester-supplied name is "requester says".

**Replay and binding.** The action hash covers `{requester_id (verified sub), audience = gate agent id, action canonical form, nonce from the gate agent, exp}`. Decide-once per request id on the gate agent (as D7). The approval never leaves as a bearer token in shape D, so token theft is moot; in shape E the token is audience-bound and single-use at the resource server.

**Unsolicited-request spam / approval fatigue.** CIBA's `user_code` (F2) answers a real problem: anyone who can reach the endpoint can push cards. Our analogue: only registered requesters can create requests; per-requester rate limit and a "mute requester" Deny-class action without UV.

**I2 for external requesters.** Hook deadline semantics do not exist; the requester must supply `deadline` and the gate agent denies at `deadline − 10 s`. Never queue (D4 spirit).

### 4.5 Phishing the approval card by prompt injection

With arbitrary requesters the card is the attack surface (F14: humans in the loop are the mitigation only if they see the truth). Rules:
- Render from the parsed action (`tool_input`, diff, deploy target), never from a requester summary. Model-authored fields (A4) and MCP descriptions are shown below, in a visually demoted "agent says" box, and never in the notification title or Live Activity.
- Show the full command, no ellipsis in the middle; wrap, do not truncate; display count of hidden/control characters; reject or visibly mark bidi controls and zero-width characters (F15); show mixed-script identifiers (homoglyph) warnings for hostnames and package names.
- Identity line = verified requester + machine label from pairing, not from the request.
- High-risk tags disable one-tap paths (v2 W-S10) — still valid.
- Grep finding: no source file under `apps/` or `packages/` mentions bidi/homoglyph handling (only build artefacts matched); the v1 card may already be exposed. This is a 1.x fix, valid on both branches (V3-S03).

### 4.6 Cloud and background agents the home daemon does not host

- **Claude Code on the web (Anthropic-hosted).** Hooks run (F4), so `remotectl`'s hook could run in the VM with network Custom/Full to reach the relay. Problem: the verifier, its pinned device keys and its rule store sit on a host where the agent writes files (A3). If the hook comes from the repo's `.claude/settings.json` (F5, "part of the clone"), an injected session can rewrite it to approve everything or pin its own software key. **Minimum sound shape:** hook defined in *server-managed settings* (admin-controlled, F5) with `allowManagedHooksOnly` (F4), pinned keys delivered in that managed config, verifier fetched by pinned hash at session start. Even then the ceiling is v2-§4.1: the session can kill or bypass the verifier binary; what it cannot do is forge a device signature. Label: "remote approvals in cloud sessions are as strong as a local session under a hostile local account" — i.e. a convenience + audit feature, not a containment boundary. Pairing: no terminal exists; the trust root becomes the org admin who writes managed settings (branch A only). Branch B (solo, Pro/Max): Anthropic's own Remote Control/mobile already covers cloud sessions; **do not build** for B.
- **Self-hosted runners (F6).** Better: operator controls the runner image and host `~/.claude/`; `remotectl` runs on the runner host, outside the session's writable tree, paired once at the host terminal like a normal machine. This is the 3.0 cloud story for orgs.
- **Codex cloud (A6, F8).** No per-action hook; the only enforcement points are PR merge and deploy (§4.7). Do not invent a fake approval layer.
- **Scheduled/background jobs** on the home machine are already covered by the hook path; v2's "observe `claude --bg`" stays.

### 4.7 CI/deploy gates

GitHub's custom deployment protection rule (F9) is a real enforcement point: the GitHub App's installation credential *is* the authority. Hosting that App on our relay would put authority at the relay (I1 violation). Sound design: the org's **gate agent** (`remotectl gate`) holds the App private key, receives the webhook (verified by webhook secret), shows a card with verified run claims (repo, ref, workflow, environment, run id, commit sha), verifies the device signature (and quorum, branch A), then POSTs `approved`. The relay forwards only E2E frames. Ceiling: GitHub org owners can bypass environment rules; say so. Same pattern later for Argo/Spinnaker webhooks; 3.0 should ship exactly one (GitHub).

### 4.8 Organisation-grade identity

Two identity planes, kept apart:
- **Relay account plane** (who may sign in, receive pushes, get invites): branch A may add OIDC SSO sign-in and SCIM (F13) deprovisioning. D8's "no email stored" breaks for SSO tenants — the IdP `sub` and email arrive. Store `sub` only, per tenant, opt-in; personal accounts stay passkey-only.
- **Authority plane** (`peers.json` principals, v2-§5.1): unchanged. IdP data is a **narrowing input only**: (1) SCIM deprovision → relay sends a `principal_suspended` hint; agent treats a hint as Deny-class (may only suspend, never activate); lease expiry (v2 Q-S5) makes offboarding work even if the relay withholds the hint (v2 F-B). (2) Optional policy rule "approver must be in IdP group G": the gate/agent requires a fresh, relay-signed membership statement per principal; absence = refuse. That gives relay+IdP a veto, which they already have via DoS; never a grant.
- Principal ↔ IdP binding happens at pairing: the phone includes the IdP `sub` it signed in with in pairing msg3 (encrypted, XXpsk0), the terminal shows it, the agent stores it. A relay cannot later rebind.
- Rejected: SAML/SCIM-driven *creation* of principals on agents (admin-signed widening, v2 Q-S2) — would make the IdP admin a remote root on every machine.

### 4.9 Managed policy distribution

v2's signed monotone bundle (v2-§5.2, W-S3) is the right object. 3.0 adds a second, non-relay channel: a machine-admin-owned file (e.g. `/Library/Application Support/remotectl/policy.json`, `/etc/remotectl/policy.json`) deployable by MDM, read with the same monotone intersection, and wins over user config only by narrowing. Effective policy = local ∩ managed file ∩ signed bundle. No relay-pushed policy that widens; no remote "disable remotectl" without an admin key (DoS by relay already possible, but should not be one click for a compromised admin phone — require UV and quorum where configured).

### 4.10 Compliance evidence and audit export

Builds on v2 W-S5/W-S6. Export = JSONL slice of the local chain + chain heads + relay anchors + the per-entry device signatures (decisions are already signed objects — the strongest evidence we have), packaged and signed by the agent key; `remotectl audit export --since --until` and an offline `audit verify --bundle`. Content stays customer-side (I3); the relay contributes anchors only. Do **not** claim SOC 2/ISO compliance for the product; claim "evidence for your CC-style change-approval control" only after an external reviewer reads the format (v2 Q-S8). Erasure: body/hash split (v2 W-S5) keeps chains verifiable after redaction.

### 4.11 Self-host trust model

Because the relay holds no authority and sees no content (I1, I3), self-host buys **availability, residency of metadata, and network isolation**, not decision security. Costs: a "Never" in ROADMAP §1 ("a user-deployed relay") must be reversed; APNs needs a push gateway we run (A7) which sees device tokens, timing and the foreign relay's identity; version skew across customer-operated relays; security patches we cannot force. Smallest sound design if ever built: gateway accepts only opaque payloads from relays registered with an Ed25519 key, per-relay rate limits, no payload logging, token→relay binding established through the user's authenticated session. Verdict: **not in 3.0**; write the contract ADR only if an org with budget asks (branch A).

### 4.12 Device attestation re-evaluated

- What attestation would add: proof that the pinned signing key was made by our genuine app in hardware, so an org can require "hardware-bound approver keys" (v2 W-S9 `require_hw_key` is self-reported today).
- Android Key Attestation (v2-§2 V1) attests the key itself, offline-verifiable against Google roots → best fit, but needs X.509 parsing (D13 dependency budget, v2 Q-S9) and Android is not built.
- App Attest (A1) attests an app key, not our Secure Enclave key; binding needs our SPKI hash in the attestation client data, verification needs CBOR/X.509 and Apple roots on the agent.
- Play Integrity (F11) requires Google's servers to decrypt — impossible to verify on an offline agent; only relay-side, so only as a narrowing hint or signup anti-abuse.
- Verdict: still **defer** agent-side attestation in 3.0. Allow relay-side App Attest/Play Integrity at *account registration* as anti-abuse (narrowing, no authority). Re-open when an org policy actually requires hardware proof.

### 4.13 Can a new client carry a decision under D7?

D7/ADR 0017 test: a fresh signature, made with a key pinned at terminal pairing, gated by user verification at signing time, over the canonical decision.

| Client | Fresh UV per signature? | Key pinned at pairing? | Verdict |
|---|---|---|---|
| Native Android (Keystore/StrongBox, per-use biometric) | Yes (v2 V1) | Yes | Full decisions |
| Native desktop with Touch ID (macOS SE) | Yes | Yes | Full decisions; but PWA + platform passkey already covers desktop → no security reason to build |
| Apple Watch | No (A2: wear-time passcode only); SE key exists (F16) | Could be | Deny, Mute, "open on phone". Allow only via a future ADR with `key_level: presence` that policy can refuse, never for risk ≥ medium |
| Wear OS | Unknown, likely same as watch | — | Same as watch |
| Slack/Teams buttons | No: Slack signs as Slack (F12), the Slack workspace and our app server hold authority | No | Notification (opt-in, sends metadata to a third party, against I3 spirit) + deep link + Deny. Never Allow |
| Voice assistants | No | No | Read-out of metadata only |
| CLI on another machine | Terminal is the root already | — | Out of scope (it is a terminal approval) |

### 4.14 Branch A vs branch B

| Item | A (teams shipped) | B (1.x, solo) |
|---|---|---|
| Standing rules + approve-by-exception | Yes (+ quorum exclusion) | **Yes — the main 3.0 value** |
| Card hardening | Yes | Yes |
| Local approval API (shape D, localhost) | Yes | Yes (scripts, local agents) |
| Gate agent + GitHub deployment gate | Yes | Optional (solo deploys) |
| Cloud sessions via managed settings / self-hosted runners | Yes | No (vendor app covers it) |
| SSO/SCIM narrowing, managed policy file, audit export | Yes | No |
| Self-host, attestation | No (3.x) | No |

## 5. Recommendations

### 5.1 ADR proposal: "Standing rules amend I1"

- **Status:** proposed for 3.0. **Deviates from:** ROADMAP §1 I1; generalises D24.
- **Context:** §4.2; v2-§4.9; F7 (vendor classifier as competition).
- **Decision — new I1 text:** "Nothing runs on the user's machine because the relay said so. Every machine-touching action is authorised by a paired, authenticated device, either by a decision bound to the exact request (D7) or by a *standing rule* that such a device signed with user verification, that names its machine and scope root, that the agent matches deterministically on structured fields, that is bounded in time and uses, and that is re-verified against the device's current status at each use. The agent never creates, widens or extends a rule on its own; the relay never carries one it can read."
- **Bounds:** `not_after − created_at ≤ 7 d` (default 24 h), `max_uses ≤ 200` (default 50), `Bash` = exact normalised command hash + cwd, structured matchers only on realpath'd roots, exclusion list of §4.2, rule count ≤ 50 per machine.
- **Revocation:** `rule_revoke` is Deny-class (no UV); peer revoke/replace kills rules; project realpath change kills rules.
- **Consequences:** silent auto-approvals become possible but are visible on every phone and in the audit chain; new attack surface = rule store and proposal farming (§4.3, R1–R3).
- **Rejected:** classifier/LLM auto-allow (prompt-injectable, ships content off-machine, puts a model in the grant path); writing to Claude Code `permissions.allow` (agent-writable, bypassable matchers); shell-glob rules; rules created by an admin bundle (widening, v2 Q-S2); "trust this agent for 1 h" blanket mode (unbounded object).

### 5.2 Other recommendations

1. Adopt "approval is worth its enforcement point" as a written review rule (`SECURITY.md`, ADR template field "Enforcement point / credential holder").
2. Ship card hardening first, in 1.x (V3-S03).
3. Approval API = shape D (local socket first, gate agent second); shape A only as a documented advisory MCP tool that refuses to claim enforcement; shape C rejected.
4. One CI gate (GitHub deployment protection rule) held by the gate agent; no hosted GitHub App.
5. Cloud: self-hosted runners first; Anthropic-hosted only via managed settings + `allowManagedHooksOnly`, branch A; nothing for Codex cloud beyond the PR/deploy gate.
6. Org identity as narrowing only; IdP `sub` bound at pairing; SCIM → suspend hint + leases.
7. Audit export over the v2 chain; no compliance claims without external review.
8. Defer self-host, agent-side attestation, watch/Slack Allow.

### 5.3 What 3.0 must not contain

LLM risk scoring or classifier grants; relay-side policy or rule evaluation; a hosted endpoint that accepts approval requests; a hosted GitHub App with approval rights; IdP-created principals; repo-file-rooted trust in cloud sessions; Allow from Slack/Teams/voice; Allow from watch without its own ADR; rules for `instruct`/`start`/`enroll`/`delegate`.

## 6. Risks

| # | Risk | L | I | Mitigation |
|---|---|---|---|---|
| R1 | Rule matcher bypass (shell, path traversal, symlink) | M | H | Exact hash for `Bash`; realpath; fuzz/property tests (V3-S02) |
| R2 | Proposal farming by injected agent | M | M | Proposals never broader than approved set; evidence list; 24 h default |
| R3 | Users create broad rules to kill friction, then forget | H | M | Caps, expiry, visible hits, weekly "rules in force" digest |
| R4 | Advisory MCP approval mistaken for a control | H | H | Name it "ask", docs + tool description say it is not enforced; no "verified" badge |
| R5 | Card phishing with crafted text/unicode | H | H | §4.5, V3-S03 |
| R6 | Gate agent compromise = deploy authority | M | H | Gate agent on hardened host, App key file mode 0600, quorum for prod (A), audit |
| R7 | Cloud verifier bypassed inside VM | H | M | Documented ceiling; managed hooks only; sold as audit/convenience |
| R8 | IdP misuse to grant | L | H | Narrowing-only by construction; property test effective ⊆ local |
| R9 | SSO tenants break D8 privacy promise | M | M | `sub` only, opt-in per tenant, privacy page |
| R10 | Scope creep from org features overloads a solo maintainer | H | H | Branch matrix §4.14; org items gated on paying demand |
| R11 | OIDC claim confusion (`sub` formats changing, F10) | M | M | Match on immutable ids + `job_workflow_ref`; tests with both formats |

## 7. Work items

Sizes: S ≈ 1 h, M ≈ 2 h, L ≈ 4 h Opus 5.5 (as ROADMAP-v2). All ACs machine-checkable.

1. **V3-S01 (S)** ADR "Standing rules amend I1" (§5.1) + ADR template field "Enforcement point". Deps: v2 W-S1. AC: `docs/adr/00NN-standing-rules-amend-i1.md` exists with Status/Deviates-from headers and the I1 text verbatim; `pnpm check` docs gate green.
2. **V3-S02 (L)** Standing rules engine (refines v2 W-S11): `rule_create`/`rule_revoke` kinds, use-time re-verification, exclusions, caps, `resolved by rule_id` fan-out, audit entry. Deps: V3-S01, v2 W-S2, W-S5. AC: tests — `Bash` rule never matches `cmd && x`, trailing whitespace variants, or another cwd; rule from a revoked peer does not match; `max_uses+1`th call prompts; rule created without UV refused; `instruct` never matched; fast-check: random tool inputs outside rule roots never match.
3. **V3-S03 (M)** Card hardening (1.x, both branches): bidi/zero-width detection, no mid-truncation, "agent says" box for model-authored fields, homoglyph warning on hosts/packages, title from parsed action only. Deps: none. AC: golden tests with U+202E, U+200B, Cyrillic `а` in a hostname render warnings; snapshot shows no requester text in notification title; contract test: Live Activity payload contains no model-authored field.
4. **V3-S04 (M)** Rule proposals from local audit (deterministic counters). Deps: V3-S02. AC: given a fixture log, proposal equals the union of approved inputs (never broader); no proposal for non-exact `Bash`; no network call in the proposal module (test with network disabled).
5. **V3-S05 (M)** Local approval API (shape D): Unix socket, `remotectl clients add` per-client token, request schema with `deadline`, decide-once, per-client rate limit and mute. Deps: v2 V2-AG-03 (ports). AC: unregistered socket client → 401; request without deadline rejected; decision after `deadline − 10 s` → deny; same request id decided twice → second ignored; relay schema check unchanged (no new relay columns).
6. **V3-S06 (S)** Advisory MCP "ask" tool wrapping V3-S05, explicitly non-enforcing. Deps: V3-S05. AC: tool description string contains "advisory"; response never contains a field named `verified`/`authorized`; doc test greps README section.
7. **V3-S07 (L)** Gate agent + GitHub deployment protection rule: webhook verification, OIDC/run claims on the card, device signature check, App key held locally, quorum hook (A). Deps: V3-S05, v2 W-S4 (A only). AC: forged webhook (bad HMAC) dropped; card fields equal webhook-verified values; approval POST issued only after a valid signature (fake GitHub server records zero calls otherwise); relay DB has no App key or run payload (I3 canary).
8. **V3-S08 (M)** OIDC requester verification module (pinned issuer JWKS, claim allow-list, both `sub` formats). Deps: V3-S05. AC: token with wrong `aud`, expired, or repo not allow-listed rejected; fixtures for legacy and immutable `sub` both accepted when allow-listed.
9. **V3-S09 (M)** Cloud-session mode: managed-settings snippet + `remotectl hook --managed` that refuses to start if the hook was loaded from project settings or keys are not from the managed source; self-hosted runner install doc. Deps: V2-AG-03. AC: with `CLAUDE_CODE_REMOTE=true` and keys only in repo settings, hook denies all and logs `untrusted_key_source`; integration test with fake runner layout passes.
10. **V3-S10 (M)** Managed policy file channel (intersection with local and bundle). Deps: v2 W-S3. AC: fast-check `effective ⊆ local ∩ managed ∩ bundle`; user-writable managed path (mode check) ignored with warning.
11. **V3-S11 (M, A only)** SSO sign-in (OIDC) for org tenants + SCIM deprovision → `principal_suspended` hint; IdP `sub` in pairing msg3. Deps: v2 W-S2, W-S8, owner Q-V3S2. AC: hint can only move a peer to `suspended`, never to `active` (test with forged hint); relay stores no email for SSO tenants (schema introspection); pairing transcript test shows `sub` displayed at terminal.
12. **V3-S12 (M, A only)** Audit export bundle + offline verify. Deps: v2 W-S5, W-S6. AC: tampered bundle entry → `verify --bundle` exits non-zero naming the seq; bundle contains per-decision signatures that verify with pinned SPKIs; export contains no relay-side content beyond anchors.
13. **V3-S13 (S)** `SECURITY.md` 3.0 section: enforcement-point rule, advisory "ask", cloud ceiling, rule visibility, Slack/watch limits. Deps: V3-S01. AC: grep test for six statements.
14. **V3-S14 (S, gated)** Push-gateway contract ADR for self-host. Deps: owner Q-V3S4 = yes. AC: ADR file exists with relay registration, rate limit and logging sections.

Order: V3-S03 (1.x now) → V3-S01 → V3-S02 → V3-S04 → V3-S05/S06 → V3-S13 → (A) V3-S08/S07/S09/S10/S11/S12 → V3-S14 only on demand.

## 8. Open questions for the owner (with defaults)

- **Q-V3S1. Amend I1 for standing rules in 3.0 (§5.1)?** Default: **yes**, with the bounds in §5.1; rules are the core 3.0 value on both branches.
- **Q-V3S2. Do org features (SSO/SCIM, gate agent, cloud managed-settings mode, audit export) enter 3.0 only if ≥ 1 paying org asks?** Default: **yes**; otherwise 3.0 = rules + card hardening + local API.
- **Q-V3S3. Accept that an MCP "ask" tool is advisory and ship it labelled as such, rather than not at all?** Default: **ship labelled**, behind V3-S05.
- Q-V3S4. Reverse the "Never: user-deployed relay" line for 3.x self-host? Default: no in 3.0; ADR only on demand.
- Q-V3S5. Watch Allow for low-risk requests via a `presence` key level? Default: no in 3.0; Deny/Mute/open-on-phone only.
- Q-V3S6. Store IdP `sub` (not email) for SSO tenants, breaking D8 for those tenants only? Default: yes, opt-in per tenant.
- Q-V3S7. Rule caps (7 d max, 50 uses default, 50 rules/machine)? Default: as stated.
- Q-V3S8. Relay-side App Attest at registration as anti-abuse? Default: no until abuse is observed.

## 9. Sources

- https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation (F1)
- https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html (F2)
- https://www.rfc-editor.org/rfc/rfc9396.html (F3)
- https://code.claude.com/docs/en/hooks (F4)
- https://code.claude.com/docs/en/cloud-environments (F5)
- https://code.claude.com/docs/en/self-hosted-environments-configuration (F6)
- https://code.claude.com/docs/en/permission-modes (F7)
- https://developers.openai.com/codex/security (F8)
- https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/create-custom-protection-rules (F9)
- https://docs.github.com/en/actions/concepts/security/openid-connect (F10)
- https://developer.android.com/google/play/integrity/standard (F11)
- https://docs.slack.dev/authentication/verifying-requests-from-slack (F12)
- https://datatracker.ietf.org/doc/html/rfc7644 (F13)
- https://genai.owasp.org/llmrisk/llm01-prompt-injection/ (F14)
- https://trojansource.codes/ (F15)
- https://developer.apple.com/documentation/cryptokit/secureenclave/p256 and https://support.apple.com/guide/security/secc7d85209d/web (F16)
- https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server (did not render; A1)
- Local: `docs/analysis/v2/reports/02-security.md` §2, §4.1, §4.9, §5.1–5.9, §7, §8; `docs/analysis/v2/SYNTHESIS.md`; `docs/analysis/v2/ROADMAP-v2.md`; `docs/analysis/ROADMAP.md` §1, D3, D7, D8, D24, D25; `docs/adr/0010`, `0016`, `0017`
