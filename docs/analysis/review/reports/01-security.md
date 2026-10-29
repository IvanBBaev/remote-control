# Review 01 — Security & cryptography (AREA: SEC)

Reviewer role: security & cryptography architect. Scope: as-built enforcement of I1–I4
(crypto package, pairing, decision binding, replay, relay authority, push key, key storage,
hook receiver, argv policy, logging, SECURITY.md). Card phishing is out of scope (done by
the v3 `sec-cards` lane, V3-S03…S03d).

## 1. Summary

The cryptographic core is sound and conservatively built: Noise KK / XXpsk0 with strict
nonce, AAD, prologue, padding and failure-state handling; decide-once with a persisted
passkey counter; a 60-bit pairing code with 3 failed handshakes per single-use slot; a
loopback hook receiver with Origin/Host checks and constant-time token compare; and an
AST-level argv gate. The main gap is not in the code paths reviewed but in the trust
boundary: **the relay host serves the PWA's JavaScript**, so for PWA users a compromised
relay host can read plaintext (I3) and obtain a UV-bound signature on a decision the user
did not see (I1), and SECURITY.md claims the opposite. The relay sends no security headers.
**Verdict — M1 (PWA + agent): ready-with-fixes** (RV-SEC-01, RV-SEC-02, RV-SEC-03).
**Verdict — native TestFlight: ready-with-fixes** (RV-SEC-07; W-S9 recommended, not blocking).
Findings: 1 high, 4 medium, 7 low (12 total). Work items: 9.

## 2. Verified facts (path:line)

Crypto (`packages/crypto`):
- V1. CipherState nonce = 4 zero bytes + 64-bit BE counter; limit `2**32` messages
  (`src/noise/cipher-state.ts:14`, `:17-23`). Encrypt reserves the nonce synchronously
  (`:72-77`); decrypt advances the counter only on success (`:79-85`).
- V2. Transport AAD = `canonicalJson(header)` (`src/session/transport-session.ts:14-16`);
  sends/receives are serialised; any decrypt failure closes the session (`:101-116`);
  frame size checked before decrypt.
- V3. Padding is 256-byte blocks with strict unpad rejecting non-zero fill
  (`src/session/padding.ts:35-52`).
- V4. Prologues `"rc/v1"||userId||phoneId||agentId` and `"rc/v1/pair"||userId||agentId`
  validate canonical lower-case UUIDs (`src/session/prologue.ts:5`, `:26-48`).
- V5. HandshakeState validates options (`src/noise/handshake-state.ts:101-132`), rejects
  out-of-turn messages (`:180-191`), enters a terminal failed state on any error
  (`:209-217`), enforces 65535 / truncation (`:264-274`), mixes `e` into the key with psk
  (`:240`, `:279`).
- V6. X25519 maps low-order input / all-zero output to `invalid_argument`
  (`src/primitives/x25519.ts:32-44`); tested on both backends
  (`src/primitives.test.ts:150-198`, `describe.each(BACKENDS)` at `:99`).
- V7. ES256 DER→raw conversion is strict (`src/primitives/ecdsa.ts:12-49`); noble verify
  checks the P-256 SPKI prefix (`src/backends/noble.ts:82-97`); ES256 tested on both
  backends (`src/primitives.test.ts:222`).
- V8. The backend is a process-global mutable (`src/backend.ts:56-66`); the native app is the
  only `nobleBackend` user (`apps/mobile/src/adapters/platform.ts`).
- V9. Noise vectors, handshake, pairing, property and push-summary tests never select a
  backend: `noise.test.ts`, `vectors.test.ts`, `pairing.test.ts`, `properties.test.ts`,
  `push-summary.test.ts` contain 0 references to `setCryptoBackend`/`noble`. They run on
  WebCrypto only.
- V10. `pairingFingerprint` = first 40 bits of `SHA-256(phone_pub||agent_pub)`, shown
  `ABCD-EFGH` (`src/fingerprint.ts:9-29`); confirmed on both ends
  (`apps/agent/src/core/pairing.ts:238-244`, `packages/phone-core/src/realtime/phone.ts:365`).
- V11. Test run (this review, host load average ~85): `packages/crypto` 111/114 passed;
  the 3 failures are 5 s timeouts in `src/properties.test.ts` (P1 truncation, P2 reorder,
  P3 cross-session), no assertion failure. The properties file sets no per-test timeout.

Pairing (D6, R10):
- V12. Code: 60 bits from 8 random bytes; `psk = HKDF(code,"","rc/v1/pair-psk")`; the relay
  gets only `HKDF(psk,"","rc/v1/pair-slot")` (`apps/agent/src/core/pairing-code.ts`).
- V13. Joining is scoped to the phone's own `userId` and the code hash; a slot is joined at
  most once; failed handshakes reopen it until `MAX_FAILED_HANDSHAKES`
  (`apps/relay/src/core/pairing-service.ts:132-165`, `:193-209`;
  `apps/relay/src/adapters/drizzle-device-registry.ts:279-290`). Failures are counted only
  when the agent calls `fail` (`apps/agent/src/core/pairing.ts:229-235`); frames from a
  phone other than the joiner are ignored, not counted (`:217-224`).
- V14. Join/open/slot endpoints are rate-limited in process per replica
  (`apps/relay/src/http/pairing-routes.ts:11`, `:163`, `:182`, `:206-254`).
- V15. Pairing msg3 carries the phone's passkey SPKIs and the native device key, authenticated
  by XXpsk0 (`apps/agent/src/core/pairing.ts:303-313`). A peer with neither gets only a
  warning (`:254-262`).

Decision binding and replay (D7, ADR 0010, M4-04):
- V16. `expires_at === issued_at + 300` is a schema refine
  (`packages/protocol/src/canonical-decision.ts:56-59`); `issued_at` has no upper bound
  against `now` anywhere (`apps/agent/src/core/decision-check.ts:80-104` checks
  `now >= expires_at*1000` only).
- V17. `checkDecision` order: session → kind supported → pending/ended → kind fits →
  `always` destination → hash → expiry → deadline → peer ids → `requiresAssertion &&
  !verified` → answer valid (`apps/agent/src/core/decision-check.ts:80-104`).
- V18. `checkAssertion`: credential known, `type == webauthn.get`, challenge =
  `decisionChallenge(decision)`, `rpIdHash == sha256(passkey.rpId)`, UP+UV flags, ES256 over
  `authData||sha256(clientDataJSON)`, counter must increase unless both are 0
  (`apps/agent/src/core/assertion-check.ts:52-96`). `clientDataJSON.origin` and
  `crossOrigin` are not checked.
- V19. `checkDeviceSignature`: ES256 over the 32-byte decision hash, trusting the
  phone-declared `deviceKey.userVerified`; no counter
  (`apps/agent/src/core/device-signature-check.ts:21-37`). The app always declares
  `userVerified: true` (`apps/mobile/src/core/authorize.ts:34-42`).
- V20. Legacy relay-trust path: a peer with no passkeys and no device key is accepted when
  `envelope.decisionHash === decisionHash(decision)` (`apps/agent/src/core/session-hub.ts:597-599`);
  ADR 0010 defers refusal ("A later WP may refuse legacy peers outright",
  `docs/adr/0010-agent-side-assertion-check.md:58`).
- V21. Decide-once runs synchronously after `verify`, with a `shown !== pending` guard; the
  passkey counter floor is persisted across restarts (`apps/agent/src/core/session-hub.ts:641-760`,
  `:68`). start/instruct use a `used` map keyed by `request_id` until `expires_at` (`:238`,
  `:766-830`).
- V22. Native device key: P-256, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`,
  `[.privateKeyUsage, .biometryCurrentSet]`, Secure Enclave on device, a keychain key with the
  same ACL on the simulator; `secureEnclave` is reported to JS but not sent to the agent
  (`apps/mobile/modules/device-key/ios/DeviceKeyModule.swift:5-20`, `:77-109`).

Relay surface, PWA and push:
- V23. The relay serves the PWA bundle via `@fastify/static`
  (`apps/relay/src/http/static-site.ts:25-53`). `grep` for CSP / helmet / `frame-ancestors` /
  HSTS / `nosniff` / `referrer-policy` across `apps/relay/src`, `apps/web/src`,
  `apps/web/index.html`: 0 hits. `dangerouslySetInnerHTML`/`innerHTML`/`eval` in web and
  phone-core: 0 hits.
- V24. PWA identity: non-extractable X25519 `CryptoKey` in IndexedDB; on `DataCloneError`
  the raw 32-byte seed is stored instead (`apps/web/src/pairing/key-store.ts:33-39`,
  `:119-126`). Push key is imported decrypt-only (`:82-87`). Passkey SPKIs live in
  `localStorage` (`apps/web/src/main.tsx:28`, `packages/phone-core/src/auth/passkey-keys.ts`).
- V25. Push summary: AES-GCM, AAD `"rc/v1/push"||envelope id`; NSE tries each pairing key and
  lets GCM authentication pick (`apps/mobile/targets/notification-service/NotificationService.swift:54-96`);
  push keys stored `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` (`apps/mobile/src/adapters/notifications.ts:23`,
  `apps/mobile/src/adapters/secure-key-store.ts:15`).
- V26. APNs body is `{aps, rc}` with a generic alert whose title names the machine
  ("Approval needed on <machine>") and `mutable-content: 1`; device tokens are hex-validated
  before reaching the URL path (`apps/relay/src/adapters/apns-sender.ts:45`,
  `apps/relay/src/adapters/apns-sender.test.ts:81-113`).

Agent local surface:
- V27. Hook receiver binds `127.0.0.1` only; rejects any `Origin`, a `Host` other than
  `127.0.0.1:<port>`/`localhost:<port>`, and a bearer token that fails `bytesEqual`
  (constant-time over equal lengths) (`apps/agent/src/adapters/hook-receiver.ts:10`, `:88-102`,
  `:130`; `packages/crypto/src/bytes.ts:27-32`). No decide route.
- V28. Secret files: atomic write via temp file opened `wx` with mode from creation, then
  rename (`apps/agent/src/adapters/node-file-system.ts:47-53`); 0600 files, 0700 dirs; a
  looser mode found at load is tightened with a warning
  (`apps/agent/src/adapters/file-key-store.ts:24-26`, `:75-79`).
- V29. Argv gate: only four process modules may import `child_process`; argv only as literal
  arrays from `...Argv` builders; forbidden tokens incl. `--dangerously-skip-permissions`,
  `bypassPermissions`, `dontAsk`, `--allowedTools`, `--settings`
  (`apps/agent/scripts/check-argv-policy.mjs:1-56`). SDK sessions get `permissionMode` only
  from the zod enum `['plan','default','acceptEdits']`
  (`packages/protocol/src/domain/permission-mode.ts:8-10`), bounded by config
  (`apps/agent/src/core/launcher.ts:195`) and always with `canUseTool`
  (`apps/agent/src/adapters/claude-sdk/sdk-sessions.ts:300-301`).
- V30. Log redaction is by exact key name: `token, secret, payload, ciphertext,
  push_endpoint, challenge, pairing_code, password` at top level and one level deep, plus
  `req.headers.authorization|cookie` (`packages/log/src/redact.ts:9-30`). The dynamic privacy
  gate scans relay logs, DB rows, pushes and agent logs for run canaries
  (`packages/test-harness/src/privacy-gate.ts:1-60`).

## 3. Assumptions

- A1. "M1" = first public release of agent + PWA + relay; "native TestFlight" = the
  `apps/mobile` build with the noble backend and Secure Enclave key.
- A2. The production relay serves the PWA from the same origin that is the WebAuthn RP ID
  (V23); no separate static host exists in the deploy config. Not verified against Railway.
- A3. Noble's `x25519.getSharedSecret` throws on an all-zero result (relied on at
  `packages/crypto/src/backends/noble.ts:76-80`); covered indirectly by V6.
- A4. Test timeouts in V11 are load-induced (8 parallel reviewers); not reproduced on an idle
  host.

## 4. Findings

**F1 (high) — The relay host serves the PWA code; for PWA users I1/I3 rest on the relay
being honest.** Evidence: V23, V24, V15, V18; SECURITY.md row `SECURITY.md:97` says a
compromised host "Cannot read content, forge a decision". Why it matters: whoever controls
the relay deployment (or its build pipeline, or the static files) can ship JS that (a) reads
decrypted cards and the identity key (non-extractable keys still sign/derive on its behalf),
(b) builds decision B and asks WebAuthn to sign `decisionChallenge(B)` while showing A — the
agent verifies a genuine UV assertion over B, and (c) during pairing hands the agent attacker
passkey SPKIs in msg3. All agent-side checks pass. This is the standard "web E2E" limit, but
the doc states the opposite and there is no CSP/SRI to narrow it to a full host compromise
(F2). The native app is unaffected (code ships via the App Store). Touches: I1, I3, D7, ADR
0010, R7, R9.

**F2 (medium) — No security headers on the relay/PWA origin.** Evidence: V23. Missing CSP
(`script-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`),
`X-Content-Type-Options: nosniff`, `Referrer-Policy`, HSTS, `Permissions-Policy`. Why: no
`frame-ancestors` allows clickjacking of the approve button (UV still required, but a framed
Allow tap is the attack); no CSP means any future injection sink or third-party script runs
with key access. Touches: I1, I3, R9.

**F3 (medium) — SECURITY.md is materially out of date.** Evidence: `SECURITY.md:8-10` "M0 in
progress"; `:107-111` agent-side assertion check "_planned_, M2" (shipped, ADR 0010/M2-03,
V18); `:115-117` relay sees "the WebAuthn assertion beside a decision envelope" (now inside
it, ADR 0010); `:145` "All primitives via WebCrypto" (noble backend, ADR 0017, V8); no mention
of the native app, Secure Enclave device signature (V19, V22), APNs/NSE (V25-V26), legacy
relay-trust peers (V20), the readable-seed fallback (V24) or F1. Why: a security policy that
overstates guarantees is itself a vulnerability for users choosing PWA vs native. Touches:
all invariants; owner of the file is the v3 `sec-cards` lane (V3-S13 covers only the 3.0
section, not the current drift).

**F4 (medium) — Legacy relay-trust peers are still accepted, and new keyless pairings are
allowed.** Evidence: V20, V15. A phone that sends neither passkeys nor a device key (e.g.
after site-data loss, or a PWA whose `localStorage` was cleared before re-pairing) is
silently paired at relay-trust level; for such a peer a compromised relay can approve with no
biometric anywhere. A relay cannot strip keys from msg3 (XXpsk0), so the downgrade is
user-side, not relay-side — but nothing tells the user their machine accepts relay-trusted
decisions after pairing. Touches: I1, ADR 0010, R7.

**F5 (medium) — Noise handshake/transport vectors never run on the noble backend.**
Evidence: V9, V8. Only primitives are cross-tested (V6, V7). The native app — the release
the brief asks to ship to TestFlight — runs the whole Noise stack on noble. A divergence in
key import, `split`, or HKDF chaining on noble would surface only at interop time on a device.
Touches: D-crypto (ADR 0017), R7.

**F6 (low) — Readable identity seed in the PWA when IndexedDB cannot clone a CryptoKey.**
Evidence: V24. On those browsers any script on the origin (F1/F2) or an extension with
storage access can exfiltrate the long-term X25519 key and impersonate the phone at the
Noise layer. Allow still needs a passkey assertion, but Deny/Stop and reading all content do
not. Touches: I3, W-S9 (native only).

**F7 (low) — `clientDataJSON.origin` is not checked.** Evidence: V18. The rpIdHash check
binds the RP ID; origin is defence in depth (a same-RP-ID subdomain or `crossOrigin: true`
iframe ceremony would pass). The rpId itself comes from msg3. Touches: ADR 0010.

**F8 (low) — `issued_at` is not bounded against the agent clock.** Evidence: V16. A phone
(or malicious PWA JS, F1) can mint a decision with `issued_at` far in the future; it stays
valid past the 300 s window until the request deadline, and for start/instruct the `used`
map entry is retained until that future `expires_at` (memory growth bounded only by rate
limits). Touches: D7, R17.

**F9 (low) — Device-key user verification is self-declared and unattested.** Evidence: V19,
V22. `userVerified: true` is hard-coded; the simulator key is software; nothing proves to the
agent that the SPKI is Secure-Enclave/biometry-bound. Already covered by W-S9 (`key_level`
in the pairing hello) — not re-proposed; W-S9 should also carry `secureEnclave` from V22.

**F10 (low) — Crypto backend is a mutable process global.** Evidence: V8. Any module can
swap the backend after keys are created; noble keys are WeakMap-wrapped look-alike
`CryptoKey`s, so a mid-session swap fails closed, but a hostile or buggy dependency could
install a logging backend before startup. Touches: I3 (defence in depth).

**F11 (low) — Redaction misses secret-shaped keys.** Evidence: V30. Exact-name matching
does not cover `psk`, `seed`, `private_key`, `assertion`, `signature`, `authenticator_data`,
`device_token`/`apns_token`, `hook_token`, or keys deeper than one level. No current call
site logs them (grep found none), so this is a guard-rail gap, not a leak; the privacy gate
(V30) catches canaries only for content, not for keys. Touches: D19, R9.

**F12 (low) — Property tests are load-sensitive; review docs paraphrase invariants
wrongly.** Evidence: V11 (3 timeouts at 5 s under load). And
`docs/analysis/review/00-state.md:24-26` states I1 = "relay never sees plaintext", I3 =
"relay never holds authority", which differs from `docs/analysis/ROADMAP.md:155` (I1 =
nothing runs because the relay said so; I3 = relay sees metadata only). Reviewers citing
invariant numbers from 00-state will mislabel findings.

Strengths worth keeping (no action): V1-V5 nonce/AAD/prologue/failed-state discipline; V13
slot design (60-bit code, relay only sees a double-HKDF hash, offline brute force within the
5-minute window is infeasible, online attempts capped at 3 joins and scoped to the user's
own phones); V21 decide-once with counter floor; V27 hook receiver (DNS-rebinding-safe);
V28 atomic 0600 writes; V29 argv gate including SDK `canUseTool`; V25 push key AAD binding.

## 5. Recommendations

- R-A (F1, F3). Make the PWA trust model explicit: SECURITY.md row "relay operator / host"
  gets a PWA column: "can ship code that reads content and obtains your biometric on a
  different decision"; recommend the native app for high-assurance use. Add an agent-side
  echo: after applying a decision, the agent sends a signed "applied: <kind> <tool> <short
  summary>" receipt that the phone renders (native) — makes F1 detectable after the fact.
  *Rejected:* serving the PWA from a separate static origin (GitHub Pages) — moves trust to
  another host, breaks the RP ID/cookie same-origin design (D-auth), and adds a deploy;
  revisit only if the relay is ever operated by a third party. *Rejected:* SRI on the
  bundle — the same host serves the HTML that names the hashes, so it does not help against
  host compromise.
- R-B (F2). Add headers in `static-site.ts` via a single `onSend` hook (no new dependency;
  helmet rejected to avoid an install): CSP `default-src 'self'; script-src 'self';
  object-src 'none'; base-uri 'none'; frame-ancestors 'none'; connect-src 'self' wss:`,
  `nosniff`, `Referrer-Policy: no-referrer`, HSTS (prod only), `Permissions-Policy` with
  `publickey-credentials-get=(self)`.
- R-C (F4). Refuse new pairings with neither passkeys nor device key unless
  `remotectl pair --allow-relay-trust`; keep existing legacy peers working but print a
  `remotectl status` warning and a phone banner. *Rejected:* hard-refusing existing legacy
  peers in M1 — strands users mid-upgrade; do it in a later WP as ADR 0010 says.
- R-D (F5). Parameterise `vectors.test.ts`, `noise.test.ts`, `pairing.test.ts` and
  `push-summary.test.ts` with `describe.each([webCrypto, noble])`; give the property tests
  an explicit timeout (e.g. 30 s) and a `numRuns` that fits it.
- R-E (F6). On `DataCloneError`, refuse to store a raw seed: show "browser unsupported, use
  the app or a current browser". *Rejected:* wrapping the seed with a passkey-PRF key —
  PRF support is uneven and adds a UV prompt on every launch.
- R-F (F7, F8). Check `origin === 'https://' + rpId` and `crossOrigin !== true`; refuse
  `issued_at > now + 60 s`. Both belong in the verifier V3-A03 extracts; if V3-A03 has
  started, land them there instead.
- R-G (F10). `lockCryptoBackend()` after platform selection; `setCryptoBackend` throws once
  locked.
- R-H (F11). Extend `SENSITIVE_KEYS` and add a test that logs each; consider pino
  `redact` with `**`-style coverage via a serializer for nested objects.

## 6. Risks (new; numbering continues after R19, prefixed to avoid collisions with other reviews)

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R20-SEC | Relay deploy/pipeline compromise ships malicious PWA JS: content read + mis-bound UV signature (F1) | low | critical | RV-SEC-01, RV-SEC-02, native app recommendation |
| R21-SEC | Noble backend divergence breaks native pairing/session only on device (F5) | low | high (TestFlight blocker) | RV-SEC-07 |
| R22-SEC | Silent downgrade of a re-paired PWA to relay-trust (F4) | medium | high | RV-SEC-03 |
| R23-SEC | Users trust SECURITY.md claims that the code does not deliver (F3) | high | medium | RV-SEC-01 |

## 7. Work items

Lane-owned paths marked `[lane:<name>]` per `docs/analysis/v3/PARALLEL.md`.

| ID | Title | Size | Deps | Files | Machine-checkable AC | Finding |
|---|---|---|---|---|---|---|
| RV-SEC-01 | SECURITY.md accuracy pass for the current release (PWA trust row, native/SE, APNs, legacy peers, noble, status line) | S | none (coordinate with V3-S13) | `SECURITY.md` [lane:sec-cards] | `grep -c "M0 in progress\|_planned_, milestone M2\|All primitives via WebCrypto" SECURITY.md` = 0; `grep -c "Secure Enclave" SECURITY.md` ≥ 1; `grep -ci "serves the PWA" SECURITY.md` ≥ 1 | F1, F3 |
| RV-SEC-02 | Security headers on every relay response incl. static PWA | S | none | `apps/relay/src/http/static-site.ts`, new `apps/relay/src/http/security-headers.ts` + test | relay test: `GET /` and `GET /api/<any>` responses carry `content-security-policy` containing `frame-ancestors 'none'` and `script-src 'self'`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`; HSTS present when `NODE_ENV=production` | F2 |
| RV-SEC-03 | Refuse keyless pairing unless `--allow-relay-trust`; warn on legacy peers in `status` | S | none | `apps/agent/src/core/pairing.ts`, `apps/agent/src/cli/main.ts`, tests | pairing test: msg3 with no passkeys and no deviceKey → slot `fail`, no peer stored; with flag → stored and `status` output matches `/relay-trust/` | F4 |
| RV-SEC-04 | Remove readable-seed fallback in the PWA key store | S | none | `apps/web/src/pairing/key-store.ts` + test | test: `put` throwing `DataCloneError` → `identity()` rejects with `UnsupportedBrowserError`; IndexedDB contains no `seed` field | F6 |
| RV-SEC-05 | Assertion check: verify `clientDataJSON.origin` and `crossOrigin` | S | V3-A03 if started | `apps/agent/src/core/assertion-check.ts` [lane:requester while V3-A03 open] | test: valid assertion with origin `https://evil.example` → `{ok:false, reason:'origin'}`; `crossOrigin:true` → refused | F7 |
| RV-SEC-06 | Refuse decisions with `issued_at` > now + 60 s | S | V3-A03 if started | `apps/agent/src/core/decision-check.ts` [lane:requester while V3-A03 open] | test: `issued_at = now+61` → `{ok:false, reason:'future'}`; `now+59` → ok | F8 |
| RV-SEC-07 | Run Noise vectors, handshake, pairing and push-summary tests on both backends; explicit property-test timeout | S | none | `packages/crypto/src/{vectors,noise,pairing,push-summary,properties}.test.ts` | `vitest run --reporter=verbose` output lists vector suites for both `webcrypto` and `noble`; `properties.test.ts` sets a timeout ≥ 30000 | F5, F12 |
| RV-SEC-08 | Lock the crypto backend after selection | S | none | `packages/crypto/src/backend.ts`, `apps/mobile/src/adapters/platform.ts`, test | test: `lockCryptoBackend(); setCryptoBackend(x)` throws `CryptoError('invalid_state')` | F10 |
| RV-SEC-09 | Extend redaction keys and test them | S | none | `packages/log/src/redact.ts`, `packages/log/src/log.test.ts` | test: logging `{psk, seed, private_key, assertion, signature, device_token, apns_token, hook_token}` (top level and `x.<key>`) yields `[Redacted]` for each | F11 |

Not re-proposed (cite instead): W-S9 (device key level / SE attestation, F9 — add the
`secureEnclave` flag from V22), W-S12 (relay never sees `request_id`/hash), W-S14 (local
`peers revoke`), W-S13 (tenancy/global limits for pairing endpoints, V14 is per replica),
V3-S13 (SECURITY.md 3.0 section), V3-A03 (verifier extraction — RV-SEC-05/06 fold into it).
The 00-state invariant paraphrase (F12) is a fix for the review orchestrator, not a WP.

## 8. Open questions for the owner

1. Is the PWA meant to be a high-assurance client, or a convenience client with the native
   app as the trusted one? *Default:* convenience; document it (RV-SEC-01) and recommend
   the native app for Allow/Start.
2. Should keyless pairing be refused by default in M1 (RV-SEC-03)? *Default:* yes, with
   `--allow-relay-trust` as the escape hatch.
3. The APNs alert names the machine (V26), visible to Apple. Acceptable metadata?
   *Default:* yes, keep; offer a "generic title" setting later.
4. Should the agent send an "applied" receipt (R-A) in M1? *Default:* no, post-M1; the
   documentation fix is enough for M1.
5. Browsers that cannot store a non-extractable key (RV-SEC-04): refuse, or allow with a
   warning? *Default:* refuse.

## 9. Sources

- Code: `packages/crypto/src/**` (noise, session, primitives, backends, fingerprint,
  bytes, tests); `apps/agent/src/core/{decision-check,assertion-check,device-signature-check,session-hub,pairing,pairing-code,pairing-lock,launcher}.ts`;
  `apps/agent/src/adapters/{hook-receiver,node-file-system,file-key-store}.ts`;
  `apps/agent/src/adapters/claude-sdk/sdk-sessions.ts`; `apps/agent/scripts/check-argv-policy.mjs`;
  `apps/relay/src/core/pairing-service.ts`; `apps/relay/src/adapters/{drizzle-device-registry,apns-sender}.ts`;
  `apps/relay/src/http/{pairing-routes,static-site}.ts`; `apps/web/src/pairing/key-store.ts`;
  `apps/web/src/main.tsx`; `packages/phone-core/src/realtime/phone.ts`;
  `apps/mobile/src/core/authorize.ts`; `apps/mobile/src/adapters/{notifications,secure-key-store}.ts`;
  `apps/mobile/modules/device-key/ios/DeviceKeyModule.swift`;
  `apps/mobile/targets/notification-service/NotificationService.swift`;
  `packages/protocol/src/{canonical-decision,request-hash}.ts`, `packages/protocol/src/domain/permission-mode.ts`;
  `packages/log/src/redact.ts`; `packages/test-harness/src/privacy-gate.ts`.
- Docs: `SECURITY.md`; `docs/adr/0001-push-summary-key.md`, `0010-agent-side-assertion-check.md`,
  `0017-native-phone-app.md`; `docs/analysis/ROADMAP.md` §1-§2; `docs/analysis/v2/ROADMAP-v2.md`,
  `docs/analysis/v2/reports/02-security.md` §7; `docs/analysis/v3/ROADMAP-v3.md`,
  `docs/analysis/v3/PARALLEL.md`; `docs/analysis/review/00-state.md`.
- Runs: `pnpm exec vitest run` in `packages/crypto` (111/114, 3 load timeouts);
  `apps/agent` decision-check, assertion-check, device-signature-check, hook-receiver and
  argv-policy tests: 105/105 passed (a first run under the same load failed 43 tests in one
  file by timeout; the rerun passed clean).
