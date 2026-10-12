# 02 — Security architecture

Role #2 (Security architect). Status: 2026-10-12. Input: `00-brief.md`, `01-roles.md`,
web verification listed in §2/§9, and the owner's agenthropic `SECURITY.md` for the
spawner-refusal comparison. Everything not verified is in §3.

## 1. Summary

1. Shippable under five conditions (§4.1): the relay never carries authority; the agent acts only on messages authenticated by a paired phone's E2E session; every machine-touching action carries a WebAuthn user-verified assertion bound to that exact request; spawn argv and project allow-list are local config the protocol cannot change; no inbound surface except a loopback hook endpoint with no "decide" API.
2. E2E: Noise `KK` sessions (X25519 / AES-256-GCM / SHA-256) on WebCrypto, ~250 lines, checked against published Noise vectors; `@noble/curves` fallback for browsers without X25519.
3. Pairing: one `XXpsk0` handshake whose PSK is a 32-byte token in the QR the phone scans from the agent's terminal; fingerprints confirmed on both ends; relay never learns the token.
4. Decisions bind `request_id` + SHA-256 of the exact tool input, expire in 300 s, are decide-once, and carry a passkey assertion whose challenge is the decision hash (relay-verified now, agent-verified in phase 2).
5. Accounts: passkeys only, no email, one recovery code; `__Host-` cookie, `SameSite=Strict`, Origin check.
6. Relay persists accounts, passkeys, devices, push subscriptions, sessions and a payload-free audit log — nothing else; pending requests live in the agent and are re-sent after each handshake.
7. Supply chain: npm trusted publishing with provenance, `npm audit signatures`, pnpm `minimumReleaseAge`, and a CI argv-policy gate (agenthropic's no-spawner gate, inverted).
8. Documented non-guarantee: a prompt-injected Claude session already has the user's full local permissions; remote-control adds no new capability but cannot subtract that one.

## 2. Verified facts

Cryptography in browsers and Node

- F1. `SubtleCrypto.deriveKey`/`deriveBits` with X25519: Chrome 133, Safari and iOS Safari 17.0,
  Firefox 130, Samsung Internet 29 (caniuse: https://caniuse.com/mdn-api_subtlecrypto_derivekey_x25519;
  MDN shows the runtime feature-detect pattern: https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey).
  chromestatus pages (https://chromestatus.com/feature/6291245926973440) did not render; the
  Chrome milestone comes from caniuse plus WebKit bug 284368 ("enable by default in M133").
- F2. Node WebCrypto: `Ed25519` and `X25519` are stable since v22.13.0 (also v23.5.0, v20.19.3);
  `HKDF`, `ECDH`, `AES-GCM` supported; HKDF keys are import-only, not exportable
  (https://nodejs.org/api/webcrypto.html).
- F3. `CryptoKey` objects are structured-cloneable and can be stored in IndexedDB; a
  non-extractable private key never leaves the browser's crypto layer
  (https://developer.mozilla.org/en-US/docs/Web/API/CryptoKey).
- F4. Noise spec: `KK` = `-> s / <- s / ... / -> e, es, ss / <- e, ee, se` (both statics
  pre-known, nothing transmitted in clear); `XX` = `-> e / <- e, ee, s, es / -> s, se`;
  `IK` sends the initiator's static without forward secrecy; CipherState nonce is a
  64-bit counter, `2^64-1` reserved; psk modifiers are defined in §9
  (https://noiseprotocol.org/noise.html).
- F5. `@noble/curves` 2.4.0: ESM-only, Node ≥ 20.19, audits: Trail of Bits (v2.3.0, Aug 2026),
  Cure53 (v1.6.0, Sep 2024), Kudelski (v1.2.0, 2023), Trail of Bits (v0.7.3, Feb 2023)
  (https://github.com/paulmillr/noble-curves, https://registry.npmjs.org/@noble/curves/latest).
  `@noble/ciphers`: zero dependencies, Cure53 audit Sep 2024 (https://github.com/paulmillr/noble-ciphers).
- F6. Alternatives inspected: `noise-handshake` 4.2.0 depends on `sodium-universal`
  (https://registry.npmjs.org/noise-handshake/latest); `@chainsafe/libp2p-noise` 17.0.0 depends on
  libp2p packages (https://registry.npmjs.org/@chainsafe/libp2p-noise/latest);
  `libsodium-wrappers-sumo` 0.8.4 (https://registry.npmjs.org/libsodium-wrappers-sumo/latest).

WebAuthn / passkeys

- F7. `@simplewebauthn/server` 14.0.3 (Node ≥ 20, ESM + CJS, no runtime deps);
  `@simplewebauthn/browser` 14.0.0 (https://registry.npmjs.org/@simplewebauthn/server/latest,
  https://registry.npmjs.org/@simplewebauthn/browser/latest).
- F8. `generateAuthenticationOptions({ rpID, challenge?, timeout = 60000, userVerification = 'preferred',
  allowCredentials?, extensions? })` accepts a caller-supplied `challenge`;
  `verifyAuthenticationResponse({ response, expectedChallenge: string | (c) => boolean, expectedOrigin,
  expectedRPID, credential, requireUserVerification = true })` throws when UV is required and the
  UV flag is absent, and returns `authenticationInfo.{newCounter, userVerified, credentialDeviceType,
  credentialBackedUp}` (https://raw.githubusercontent.com/MasterKale/SimpleWebAuthn/master/packages/server/src/authentication/generateAuthenticationOptions.ts,
  https://raw.githubusercontent.com/MasterKale/SimpleWebAuthn/master/packages/server/src/authentication/verifyAuthenticationResponse.ts,
  https://simplewebauthn.dev/docs/packages/server).
- F9. The assertion signature is computed over `authenticatorData || SHA-256(clientDataJSON)`, and
  `clientDataJSON` contains the challenge, origin and type — so a challenge derived from a
  request binds the signature to that request
  (https://developer.mozilla.org/en-US/docs/Web/API/AuthenticatorAssertionResponse/signature).
- F10. iOS passkeys: no persistent cross-device link, so a cross-device sign-in needs a QR scan
  each time (https://passkeys.dev/device-support/).

Claude Code (agent side)

- F11. `PermissionRequest` hook: fires "when a tool call needs a permission decision"; input has
  `session_id`, `transcript_path`, `cwd`, `tool_name`, `tool_input`, optional
  `permission_suggestions`, no `tool_use_id`; output is `hookSpecificOutput.decision.behavior`
  `allow` | `deny` (+ `message` for deny, optional `updatedInput` for allow); exit code 2 is not
  honoured. Default timeout for `command`/`http`/`mcp_tool` handlers is 600 s. In non-interactive
  runs, no decision means deny; with `--permission-prompt-tool` or the SDK `canUseTool`, "hooks run
  alongside your host, and whichever decides first applies". Hooks from user, project, local,
  plugin and managed settings all run; command hooks "execute shell commands with your full user
  permissions"; `allowManagedHooksOnly`, `disableAllHooks`, `allowedHttpHookUrls`,
  `httpHookAllowedEnvVars` exist; `ConfigChange` hooks receive `source` and `file_path` and can
  block (https://code.claude.com/docs/en/hooks).
- F12. Permissions: deny rules beat allow rules; "PreToolUse hook decisions don't bypass permission
  rules"; `Read(./.env)`/`Read(./secrets/**)` deny syntax; `Bash(command:rm *)`-style content rules
  are ignored as bypassable; `permissions.disableBypassPermissionsMode: "disable"` blocks
  `bypassPermissions`, which otherwise "skips permission prompts, including for writes to
  protected paths such as `.git` and `.claude`" (https://code.claude.com/docs/en/permissions).
- F13. Deny and ask rules apply immediately; allow rules wait for workspace trust
  (https://code.claude.com/docs/en/settings).
- F14. Agent SDK: "Anthropic does not allow third party developers to offer claude.ai login or rate
  limits for their products"; SDK sessions use API keys (https://code.claude.com/docs/en/agent-sdk/overview).

Prior art

- F15. Coucou approval binding: fingerprint = SHA-256 of `pillId, sessionId, tool, command, inputKey`
  joined by U+001F; 120 s expiry; decide-once; "Allow needs the fingerprint or screen lock, Deny
  does not"; taps in the first 600 ms are ignored
  (https://raw.githubusercontent.com/Louis-CFM/coucou/main/docs/ANDROID_LINK.md,
  https://raw.githubusercontent.com/Louis-CFM/coucou/main/android/README.md,
  https://raw.githubusercontent.com/Louis-CFM/coucou/main/docs/IPHONE.md).
- F16. Coucou relay (v1): pairing link carries `relay`, `room` (16 B), `key` K (32 B, never sent to
  relay), `access` (32 B); HKDF/HMAC/AES-256-GCM, strict counter (a gap is a fault), AAD binds
  room/direction/version/type/counter, plaintext zero-padded to 128 B, fresh nonces per connection,
  no forward secrecy for K, relay "stores nothing"
  (https://raw.githubusercontent.com/Louis-CFM/coucou/main/docs/RELAY_LINK.md).
- F17. agenthropic: loopback-only bind enforced at startup, "no browser-driven subprocess or `claude`
  spawner, ever" enforced by `scripts/check-no-spawner.mjs`, timing-safe Bearer token, no outbound
  requests (`/Users/ivanbaev/Development/agenthropic/SECURITY.md`). Its due-diligence doc records the
  rival's actual RCE: `/api/run` accepted `permission-mode` (incl. `bypassPermissions`) from the
  browser body with an optional token (`/Users/ivanbaev/Development/agenthropic/docs/independent-due-diligence.md`).

Web platform, sessions, relay

- F18. Web Push for Home Screen web apps arrived in iOS/iPadOS 16.4; the app must be installed first
  (https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/,
  https://webkit.org/blog/13966/webkit-features-in-safari-16-4/). RFC 8291 push payloads are
  encrypted to the subscription keys; the push service still sees sender/recipient and length unless
  padded (https://www.rfc-editor.org/rfc/rfc8291). `web-push` 3.6.7 (https://registry.npmjs.org/web-push/latest).
- F19. ITP deletes script-writable storage (IndexedDB, LocalStorage, Service Worker) after seven days
  of Safari use without interaction, with an exemption for web apps saved to the Home Screen
  (https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/).
- F20. OWASP session management: ≥ 64 bits of entropy (128 recommended), CSPRNG, `Secure`,
  `HttpOnly`, `SameSite=Strict` preferred, `__Host-` prefix recommended, idle and absolute
  timeouts, renew the ID after authentication
  (https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
- F21. Fastify plugins: `@fastify/cookie` 11.1.3, `@fastify/csrf-protection` 8.0.2,
  `@fastify/rate-limit` 11.2.1, `@fastify/websocket` 11.3.4 (uses `ws` ^8.16)
  (https://registry.npmjs.org/@fastify/{cookie,csrf-protection,rate-limit,websocket}/latest).
- F22. Railway Postgres is "deployed private by default"; public access is opt-in and creates a TCP
  proxy and `DATABASE_PUBLIC_URL` (https://docs.railway.com/guides/postgresql,
  https://docs.railway.com/guides/private-networking).
- F23. Node permission model is stable since v22.13.0 but is a "seat belt", not a boundary against
  malicious code (https://nodejs.org/api/permissions.html).

Supply chain and data

- F24. npm provenance: npm CLI ≥ 9.5, `id-token: write`, public `repository` field matching the
  source, `npm publish --provenance`; consumers verify with `npm audit signatures`
  (https://docs.npmjs.com/generating-provenance-statements). Trusted publishing (OIDC, no long-lived
  token): npm CLI ≥ 11.5.1, Node ≥ 22.14, GitHub-hosted runners only, exact workflow filename,
  provenance generated automatically for public repos (https://docs.npmjs.com/trusted-publishers/).
- F25. GitHub artifact attestations use the public Sigstore instance and reach SLSA Build L2
  (https://docs.github.com/en/actions/concepts/security/artifact-attestations). Push protection is
  on by default for users, off by default per repository
  (https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection).
- F26. pnpm `minimumReleaseAge` (minutes) delays installing newly published versions, including
  transitive ones; `minimumReleaseAgeExclude` whitelists packages
  (https://pnpm.io/settings/dependency-resolution).
- F27. GDPR Art. 17: erasure "without undue delay" when data is no longer necessary or consent is
  withdrawn (https://gdpr-info.eu/art-17-gdpr/).

## 3. Assumptions

- A1. WebAuthn `navigator.credentials.get` with `userVerification: 'required'` works inside an
  installed (standalone) PWA on iOS 17/18 and Chrome Android. No primary source found; the WebKit
  16.4 post covers push and badging only. Interface to report 05: confirm or provide the fallback
  (open login in the browser tab; decisions then use the bounded window of Q4).
- A2. WebAuthn PRF extension is not usable on iOS Safari (vendor blogs only). The design does not use PRF.
- A3. `AuthenticatorAttestationResponse.getPublicKey()` returns the SPKI public key on current iOS
  and Android browsers; needed only for the phase-2 agent-side assertion check (W15).
- A4. A non-extractable X25519 `CryptoKey` persisted in IndexedDB survives in an installed PWA on
  iOS under the Home Screen exemption (F19) and on Android. If it does not, the phone re-pairs.
- A5. Published Noise test vectors (the `cacophony`/`snow` vector sets) include
  `Noise_KK_25519_AESGCM_SHA256` and `Noise_XXpsk0_25519_AESGCM_SHA256`. If not, QA freezes vectors
  generated with the `snow` reference implementation (W4).
- A6. Railway terminates TLS at its edge with a valid certificate; the relay process sees plaintext
  HTTP/WS. TLS protects metadata only; content is E2E.
- A7. When a `PermissionRequest` hook returns no decision within its timeout in an interactive
  session, the normal terminal prompt remains available (the documented "whichever decides first"
  applies to hosts; the timeout path is not spelled out). Interface to report 04.
- A8. The agent spawns Claude Code with the user's own subscription (CLI), not the SDK (F14 makes
  SDK billing a product question, report 04). The security design is the same either way.

## 4. Findings

### 4.1 Remote spawning versus agenthropic's spawner refusal

agenthropic refused a spawner because the spawner would have been a new capability on a service
whose only boundary was an optional LAN token, and the rival's RCE was exactly that: the browser
chose the permission mode and the token was optional (F17). The refusal is about an unbounded
capability on an unauthenticated surface, not about spawning as such. remote-control is
acceptable when the capability is bounded so that the remote path grants nothing the local user
could not already do at the keyboard, and nothing without that user's fresh, verified consent:

1. Authority never originates at the relay. A message is executed only if it decrypts and
   authenticates under a Noise session with a paired phone (KK, mutual authentication). A relay
   operator, another tenant, or a TLS MITM can delay, drop or replay bytes, none of which the
   agent will act on (§5.2). The relay can only shrink trust (revoke, disconnect), never add it.
2. Every action that touches the machine (Allow, answer to `AskUserQuestion`, new instruction,
   new session) carries a WebAuthn assertion with `userVerification: 'required'` whose challenge is
   the hash of the exact decision (§5.4). Deny, stop and read-only views do not need it.
3. The spawn is a fixed argv: `claude` + `--cwd <allow-listed path>` + prompt as a single argument.
   No permission-mode field exists in `packages/protocol`; `--dangerously-skip-permissions`,
   `bypassPermissions`, `--allowedTools`, `--settings` are never emitted. `updatedInput` is never
   returned from the hook. CI greps for this (W11), mirroring `check-no-spawner.mjs`.
4. The project allow-list and the relay URL are local config (`~/.config/remote-control/`), not
   protocol fields; paths are resolved with `realpath` and must be inside an allow-listed root.
5. The agent binds only to `127.0.0.1` for the hook endpoint, with a per-install token, and that
   endpoint has no "decide" API; decisions arrive only over the outbound WSS session.

What this does not protect against, and must be said in `SECURITY.md`: a prompt-injected or
malicious Claude Code session already runs with the user's full permissions (F11). It can read the
agent's key file, edit `~/.claude/settings.json`, or kill the agent. remote-control does not make
the machine safer than Claude Code alone; it guarantees that the remote path adds no new capability.
The one escalation to block is self-approval: no loopback API can approve anything, and the hook
ingress only creates phone prompts. Recommended user-side hardening (shipped as a snippet, W12):
`permissions.deny` for `Read`/`Edit` of `~/.config/remote-control/**` and `~/.claude/settings.json`,
`disableBypassPermissionsMode: "disable"`, and a `ConfigChange` hook that blocks changes while a
remote session is active (F11–F13). This is a seat belt, like Node's permission model (F23).

### 4.2 Threat model

Assets: (1) the ability to execute on the user's machine; (2) permission-request content (commands,
paths, diffs, prompts — often secrets); (3) account and device identity; (4) availability of the
approval path (a stuck hook blocks the user's session, F11: 600 s).

| Actor | Can | Cannot (by design) |
|---|---|---|
| Malicious relay operator / compromised Railway | See metadata (§5.6), drop, delay, replay, revoke, send fake push, DoS | Read content, forge a decision, start a session, add a device, change the allow-list |
| Other tenant | Hit public endpoints, create accounts | Route to another user's devices (routing is keyed by `user_id` from the authenticated socket, never from a message field) |
| Stolen phone, locked | Nothing (keys are in the browser profile, UV required) | — |
| Stolen phone, unlocked | View sessions, Deny, Stop | Allow / start / instruct without the biometric (UV checked by relay now, by agent in phase 2) |
| Stolen session cookie | Call REST/WS as the user | Decrypt anything (no device key), approve anything (no UV, no device key) |
| Attacker on the home LAN | Nothing: no inbound port; hook endpoint is loopback-only | — |
| npm supply chain (agent deps) | Full user compromise if a malicious version is installed | Mitigated, not prevented: `minimumReleaseAge`, pinned lockfile, `npm audit signatures`, tiny dependency set (W13) |
| Prompt-injected Claude session | Everything the user can do locally | Approve its own request remotely (§4.1) |
| Lost machine | Attacker holds agent key + relay token | Keys are revoked from the phone (`devices revoke`); the token hash is deleted at the relay |

Trust boundaries: phone browser profile (device key, passkey) | relay (metadata, authentication
of accounts, not of actions) | agent process (keys, allow-list, argv) | Claude Code (user permissions).

### 4.3 Hypotheses

- E2E phone ↔ agent with an opaque relay — **confirmed**, with a session design instead of
  per-message sealed boxes (§5.2) and the consequence that the relay stores no payloads at all.
- Pairing by QR / short code, keys per device — **confirmed**; the QR is shown by the agent in the
  terminal and scanned by the phone, and the code is a 32-byte PSK, not a 6-digit code (§5.3).
- Passkeys for login — **confirmed**, and restricted to passkeys only (no email, no password).
- Fresh user-verifying assertion for every Allow and new session — **confirmed** for Allow,
  `AskUserQuestion` answers, instructions and session starts; **changed** for Deny/Stop (no UV).
  The assertion is request-bound, not a time window (§5.4).
- Project allow-list on the agent — **confirmed**, extended with the argv policy and the no-decide
  loopback rule (§4.1).
- "Relay sees only metadata (who, which device, online/offline, timestamps)" — **confirmed** as
  the exact plaintext list in §5.6; the relay must additionally refuse to persist any payload.

## 5. Recommendations

### 5.1 Crypto stack

X25519 + HKDF-SHA-256 + AES-256-GCM, all through WebCrypto (`globalThis.crypto.subtle`) in both
the PWA and the Node agent (F1, F2). In the PWA, feature-detect X25519 at startup (MDN pattern, F1);
if absent (browsers older than iOS 17 / Chrome 133), fall back to `@noble/curves` x25519 (F5)
with the private key stored raw in IndexedDB and a visible "reduced key protection" notice.
Alternatives: WebCrypto-only ECDH P-256 — works everywhere, but P-256 ECDH has no published Noise
vectors for the AESGCM/SHA256 suite we test against and X25519 coverage is now sufficient; lost.
libsodium (`crypto_box`/sealed boxes) — a WASM bundle in the PWA plus a second primitive set on the
agent, no forward secrecy per session; lost. `noise-handshake` / `libp2p-noise` — sodium or libp2p
dependency trees (F6); lost.

### 5.2 Sessions: Noise `KK` over the relay

- Pattern `Noise_KK_25519_AESGCM_SHA256` (F4). Phone = initiator, agent = responder. Prologue =
  `"rc/v1" || user_id || phone_device_id || agent_device_id`. Both statics are known from pairing,
  so no identity is transmitted and the handshake is mutually authenticated; `ee` gives forward
  secrecy for the transport keys. Implement the spec's HandshakeState/SymmetricState/CipherState
  verbatim (~250 lines, `packages/protocol/crypto`) and validate against vectors (A5, W4).
- Transport: each direction has its own CipherState; nonce = 32 zero bits || 64-bit big-endian
  counter (Noise AESGCM); receiver enforces `n == expected`, any gap or repeat closes the session
  (Coucou's rule, F16). AAD = canonical header bytes `v || from || to || session_id || n` so the
  relay cannot re-address a ciphertext. Plaintext is length-prefixed and zero-padded to a
  multiple of 256 bytes. Max frame 64 KiB. Re-handshake on every reconnect and before
  `n = 2^32`.
- Store-and-forward: none. Pending permission requests live in the agent; after each successful
  handshake the agent re-sends its pending set. Push carries no content (§5.6). This is what lets
  the relay keep zero payload state. Alternative (sealed box per message so the relay can queue
  offline messages): no forward secrecy, relay must persist ciphertext, duplicate suppression
  moves to the relay; lost.
- Multiple phones: one session per (phone, agent) pair; the first decision wins (decide-once), the
  others receive `resolved`.

### 5.3 Pairing

1. User runs `remote-control-agent pair`. The agent asks the relay (over its authenticated agent
   socket) for a pairing slot and prints a QR plus a 12-character fallback code. QR payload:
   `rc1:<relay-host>:<agent_device_id>:<token base64url>` with `token` = 32 random bytes from the
   agent (never sent to the relay). The relay sees only `agent_device_id` + a 5-minute slot.
2. Phone (logged in with its passkey) scans, then runs `Noise_XXpsk0_25519_AESGCM_SHA256` with
   `psk = token`, prologue `"rc/v1/pair" || user_id || agent_device_id`. Both statics are exchanged
   encrypted under PSK-derived keys, so a relay operator who sees the handshake learns nothing and
   cannot MITM: it does not know the token. The token is single-use and expires in 5 minutes.
3. Both ends display `fingerprint = base32(SHA-256(phone_pub || agent_pub))[0:8]`; the agent's
   terminal asks `Pair "<phone name>" ABCD-EFGH? [y/N]`. Defence in depth against a leaked QR.
4. Both persist the peer's static key: phone in IndexedDB, agent in
   `~/.config/remote-control/peers.json` (0600). The relay records only the pairing edge
   (`phone_device_id ↔ agent_device_id`) for routing.

Second phone: repeat with the new phone; the agent lists both. Losing a phone: on any remaining
device or via the relay's account page, revoke the phone — the relay deletes its sessions, push
subscription and routing edge and tells the agent `peer_revoked`; the agent deletes the key (a
relay may only shrink trust, §4.1). Also `remote-control-agent devices revoke <id>` locally. Losing
the machine: revoke the agent from the phone; the relay deletes the agent token hash. Key rotation:
session keys rotate per connection; static keys rotate by re-pairing (`pair --rotate` generates a
new agent static and invalidates all peers). Alternatives: Noise `XX` with TOFU — a relay can MITM
the first handshake and users do not compare fingerprints; lost. `IK` — needs a pre-known agent key in
the QR and still lacks PSK authentication of the phone; lost. Six-digit code as PSK — brute-forceable
online in 5 minutes without strict lockout; lost.

### 5.4 Decision binding and user verification

Canonical decision (CBOR-free: JSON with sorted keys, no whitespace, UTF-8):
`{ "v":1, "kind":"allow"|"deny"|"answer"|"instruct"|"start", "request_id":<uuid from agent>,
"request_hash":<hex SHA-256 of canonical tool_name+tool_input or prompt+cwd>, "payload":<answer /
instruction text / repo path or null>, "issued_at":<unix s>, "expires_at":<issued_at + 300>,
"phone_device_id", "agent_device_id" }`. The agent generates `request_id` and `request_hash` when
the hook fires and includes both in the request message; the phone echoes them.

Agent checks, in order: session authenticates (KK); `request_id` is pending and unresolved;
`request_hash` equals its own computation; `now < expires_at` and `now < hook deadline − 10 s`;
`phone_device_id` matches the session's peer; for kinds other than `deny`: the attached assertion's
`clientDataJSON.type == "webauthn.get"`, `clientDataJSON.challenge == base64url(SHA-256(canonical
decision))`, `authenticatorData` UV flag (bit 2) set and `rpIdHash == SHA-256(rpID)`. Then it marks
the request resolved and answers the hook. A decision for request A can never satisfy request B
(different `request_id` and hash); a replayed decision fails decide-once; an expired one fails the
clock check. Coucou's fingerprint-plus-120 s design (F15) is the same idea with a hash instead of a
signature; we add the hash of the exact `tool_input`, so a relay that re-orders two requests for the
same command cannot cross-apply them.

Where the assertion is verified: the phone obtains it with `startAuthentication()` using a
`challenge` supplied by the relay via `generateAuthenticationOptions({ challenge })` (F8) — the phone
sends the relay the decision hash as the challenge, the relay issues the options, and verifies the
assertion with `expectedChallenge: (c) => c === requestedHash`, `requireUserVerification: true`,
origin and rpID (F8), and keeps a 10-minute set of used challenges (passkey counters are often 0).
Only then does the relay forward the envelope. The assertion travels in the clear beside the
encrypted decision (it reveals the credential ID and an opaque hash only), and the agent performs the
structural checks above without the public key. A malicious relay can therefore skip UV but still
cannot forge the decision (the phone's KK session is required), so the compound "relay + unlocked
phone" is the residual risk, closed in phase 2 by shipping the passkey SPKI to the agent at pairing
(A3, W15) so the agent also checks the ES256 signature (F9).

Realism: one Face ID / fingerprint per Allow is what Coucou ships (F15) and costs ~1 s. Deny, Stop
and reads need none. A re-auth window (one UV, then N minutes of Allows) is weaker because the
window is a property of the phone's state, not of the request; it is the fallback only if A1 fails
(Q4). WebAuthn's own `timeout` is 60 s by default (F8); the phone must request options only when the
user taps Allow, not when the request arrives.

### 5.5 Account authentication (relay)

- Registration: passkeys only (`@simplewebauthn/*`, F7), `residentKey: 'required'`,
  `userVerification: 'required'`, one random user handle, no email, no username beyond a display
  name. Store `credentialBackedUp`; if false, show "this passkey is not synced — add a second one".
  Show one 128-bit recovery code once (store scrypt hash); it only allows registering a new passkey.
  No magic link: it would add email storage, a mail provider, and a phishable path to an account
  that otherwise has none. Losing all passkeys and the code = new account; nothing of value is
  server-side.
- Session: `__Host-rc_session`, `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, 256-bit random
  value, SHA-256 hash stored (F20); idle 7 days, absolute 30 days, renew on passkey login. Because
  every machine-touching action needs UV, a long session is acceptable.
- CSRF: `SameSite=Strict` plus mandatory `Origin` check equal to the relay origin on every
  state-changing request and on the WebSocket upgrade (cross-site WebSocket hijacking), plus a
  required `X-RC-Client: pwa` header. `@fastify/csrf-protection` (F21) is not needed while the API
  is same-origin and JSON-only; adopt it if a form endpoint ever appears.
- Agent authentication to the relay: enrollment from the logged-in phone issues a 32-byte agent
  token shown as a one-time `rc-enroll:` string the user pastes into `remote-control-agent login`
  (or embeds in the pairing QR, Q2); the relay stores its hash with `user_id` + `agent_device_id`;
  the agent sends it as `Authorization: Bearer` on the WS upgrade only (never in a URL).

### 5.6 What the relay sees, stores and refuses

Plaintext the relay must see: `user_id` (from the socket), `from`/`to` device ids, message kind
(`hs1`, `hs2`, `data`, `revoke`, `presence`), `session_id`, counter, byte length, timestamps, and the
WebAuthn assertion beside a decision envelope. Push payload: `{ "t":"attention", "agent":<id>,
"n":<pending count> }` only, encrypted per RFC 8291 (F18) — the relay composes it, so it must contain
nothing else. Tables: `users`, `passkeys`, `recovery_codes`, `devices` (kind phone|agent, name,
created/last_seen/revoked), `pairings`, `push_subscriptions`, `sessions`, `agent_tokens`,
`pairing_slots` (TTL 5 min), `audit_log` (event, user, device, ts — no bodies). Refuse: any message
table, any field beyond the envelope schema (zod `.strict()` on every WS frame, unknown keys →
close 1008), any log line with a body (pino `redact` + a test that greps logs for a canary string,
W9). Presence lives in memory. Railway Postgres stays private (F22).

### 5.7 Tenant isolation, limits, abuse

Routing is a map `(user_id, device_id) → socket`; the `to` device must belong to the socket's
`user_id` or the frame is dropped and counted. Limits (`@fastify/rate-limit`, F21, plus a
per-socket token bucket): registration 5/h per IP, login 20/h per IP, pairing slots 10/day per
user, WS frames 50/s and 2 MB/min per socket, 5 phones + 5 agents per user, 1 push per agent per 30 s.
Thousands of throwaway accounts: there is no email cost to the attacker, so launch with an invite
code (Q6) and prune accounts with no device for 30 days. Idle agent sockets cost memory only.

### 5.8 Public repo hygiene and supply chain

Secrets only in Railway variables; `.env*` git-ignored and a deny rule for Claude (F12); enable
repo-level push protection and secret scanning (F25). Agent package: `files` whitelist, exact
`engines`, no postinstall, `npm pack --dry-run` reviewed in CI; publish only through trusted
publishing from a tagged GitHub Actions run with provenance (F24); users install with
`npx @ivanbbaev/remote-control-agent@<exact>` and the README shows `npm audit signatures`. Repo:
`pnpm install --frozen-lockfile`, `minimumReleaseAge = 4320` (3 days, F26) with no excludes,
Renovate weekly grouped. Keep the agent's runtime dependency count under ten; Noise is in-repo.
GitHub artifact attestations (F25) only if a standalone binary is ever shipped.

### 5.9 Retention and GDPR-minimal handling

Personal data held: user handle (random), passkey public keys, device names, push endpoints,
session hashes, IPs in request logs (14 days, then dropped), audit events (90 days). No email, no
names, no content. Account deletion: one endpoint with UV, cascade delete, push unsubscribe,
agents receive `account_deleted` on next connect; done synchronously (F27). Inactive accounts
(no device seen for 12 months) are deleted after a push warning. Privacy page lists exactly this.

## 6. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | WebAuthn UV not callable in installed iOS PWA (A1) | Medium | High: per-request UV impossible on iOS | Report 05 verifies in week 1; fallback = bounded re-auth window (Q4) with browser-tab login |
| R2 | Own Noise implementation bug | Medium | High | Spec-verbatim structure, published vectors, property tests (§7 W4/W5), later audit of ~250 lines |
| R3 | IndexedDB key loss on iOS (A4) | Medium | Low: re-pair | Export nothing; re-pair flow is 30 s |
| R4 | Compromised relay + unlocked phone skips UV | Low | High | Phase-2 agent-side assertion verification (W15) |
| R5 | Malicious dependency in agent | Low | Critical | §5.8; dependency budget; `minimumReleaseAge` |
| R6 | Hook timeout (600 s) blocks the user's session while phone is unreachable | High | Medium | Agent answers before the deadline; terminal prompt stays usable (A7); push retry |
| R7 | Prompt-injected session disables hooks or edits agent config | Medium | Medium | §4.1 hardening snippet; documented as out of scope for guarantees |
| R8 | Account farming / relay abuse on hobby tier | Medium | Medium | Invite codes at launch, limits in §5.7 |
| R9 | Lost phone with session still valid | Low | Low | Revocation from any device; UV required for actions |
| R10 | Decision applied to the wrong request after reconnect | Low | High | `request_id` + `request_hash` + decide-once; property test W5 |

## 7. Work items

Sizes: S ≤ ½ day, M ≤ 2 days, L ≤ 1 week. "AC" = acceptance criterion.

1. **W1 (S)** Threat model and `SECURITY.md` in the repo root (§4.1, §4.2, non-guarantees).
   AC: file exists, lists the five conditions and the "same-user" non-guarantee verbatim.
2. **W2 (S)** `packages/protocol`: zod `.strict()` envelope schemas (`hs1`, `hs2`, `data`, `revoke`,
   `presence`, `push`), canonical decision JSON, no permission-mode or argv fields.
   AC: a test asserts the schema rejects an extra key and the decision canonicalisation is byte-stable.
3. **W3 (M)** WebCrypto primitives wrapper for PWA and Node (X25519, HKDF, AES-GCM, SHA-256) with
   feature-detect and `@noble/curves` fallback. AC: RFC 7748 §6.1 X25519 vector and RFC 5869
   test case 1 pass on Node 22 and in Playwright WebKit/Chromium.
4. **W4 (L)** Noise engine: HandshakeState/SymmetricState/CipherState, patterns `KK` and `XXpsk0`,
   AESGCM nonce layout, prologue, AAD, padding. Depends on W3. AC: published vectors for
   `Noise_KK_25519_AESGCM_SHA256` and `Noise_XXpsk0_25519_AESGCM_SHA256` pass (or frozen `snow`
   vectors, A5).
5. **W5 (M)** Transport session + property tests: strict counter, reorder/replay/tamper/re-address
   rejection, re-handshake on reconnect, pending re-send. Depends on W4. AC: fast-check properties
   in §7.1 all hold for 1 000 runs.
6. **W6 (M)** Pairing flow: agent `pair` command (QR + code, 5-min single-use token, fingerprint
   confirm), phone scan screen, relay pairing slot, `peers.json` 0600. Depends on W4.
   AC: E2E test with fake relay: wrong token → handshake fails; relay-substituted static → fails;
   correct token → both store identical fingerprints.
7. **W7 (M)** Relay passkey registration/login with `@simplewebauthn/*`, recovery code, `__Host-`
   session, Origin check, header check. AC: integration tests: missing Origin → 403, cross-origin
   WS upgrade → 403, UV flag absent on login → 401, recovery code usable once.
8. **W8 (M)** Decision binding on the agent (§5.4 checks) and request-bound assertion issuance on
   the relay (`challenge` = decision hash, `expectedChallenge` function, used-challenge set).
   Depends on W2, W7. AC: tests in §7.2 pass; a decision with a foreign `request_id`, a stale
   `expires_at`, a mismatched `request_hash`, or a challenge ≠ hash is rejected and logged as an event only.
9. **W9 (S)** Relay logging policy: pino redact list, canary test. AC: a test sends a frame
   containing `CANARY-7f3a` and greps all log output for its absence.
10. **W10 (M)** Tenant routing + limits (§5.7), device quotas, invite codes. AC: a frame addressed to
    another user's device is dropped and increments `rc_cross_tenant_drop_total`; limits return 429.
11. **W11 (S)** CI static gate `scripts/check-argv-policy.mjs`: the agent's spawn module is the only
    `child_process` import, argv is a literal array, forbidden flags (`--dangerously-skip-permissions`,
    `bypassPermissions`, `--allowedTools`, `--settings`) and `updatedInput` fail the build.
    AC: gate fails on a fixture containing each forbidden token; passes on `main`.
12. **W12 (S)** Agent hardening: loopback-only bind with exit on failure (agenthropic pattern),
    per-install hook token, `realpath` allow-list check incl. symlink and `..` fixtures, recommended
    `permissions.deny` + `ConfigChange` snippet in the README. AC: unit tests for each fixture path.
13. **W13 (S)** Supply chain: trusted publishing workflow with provenance, `npm audit signatures`
    in CI, `minimumReleaseAge`, `files` whitelist, push protection on. AC: `npm view <pkg> dist.attestations`
    is non-empty after the first release; CI fails if a dependency lacks a registry signature.
14. **W14 (S)** Revocation and deletion: phone/agent revoke, account delete cascade, inactive purge.
    AC: after revoke, a frame from the revoked device is dropped and the agent has deleted the peer key.
15. **W15 (M, phase 2)** Agent-side assertion signature check: ship SPKI at pairing (A3), verify
    ES256 over `authenticatorData || SHA-256(clientDataJSON)` (F9). AC: a tampered `signature`
    is rejected by the agent even when a fake relay forwards it.

### 7.1 Properties for QA (report 07)

- P1 Any single-bit change in ciphertext, AAD or counter → decrypt fails, session closes.
- P2 Delivering frames in any order other than `n, n+1, …` → rejection; no frame is applied twice.
- P3 A frame recorded under session S is rejected under session S' of the same peers.
- P4 A relay that swaps `to`/`from` or `session_id` in the header → AAD mismatch.
- P5 Plaintext lengths within the same 256-byte bucket produce equal ciphertext lengths.
- P6 Pairing with any token other than the one in the QR → handshake aborts before statics are learned.
- P7 Decision(request A) never resolves request B; a second decision for A is a no-op.
- P8 Decision with `expires_at` in the past, or arriving after the hook deadline → deny path.
- P9 For `allow|answer|instruct|start`, missing/malformed assertion, UV bit 0, wrong rpIdHash or
  challenge ≠ SHA-256(decision) → rejected; for `deny` no assertion is required.
- P10 `cwd` outside allow-list after `realpath` (symlink, `..`, trailing-space tricks) → rejected.
- P11 Any `child_process` use outside the spawn module or any forbidden flag → CI gate fails.
- P12 No log line ever contains a frame body (canary).

### 7.2 Test vectors

- X25519 (RFC 7748 §6.1): Alice sk `77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a`,
  pk `8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a`; Bob sk
  `5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb`, pk
  `de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f`; shared
  `4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742`.
- HKDF-SHA-256 (RFC 5869 test case 1): IKM `0b`×22, salt `000102…0c`, info `f0f1…f9`, L 42 → OKM
  `3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865`.
- Noise: the `Noise_KK_25519_AESGCM_SHA256` and `Noise_XXpsk0_25519_AESGCM_SHA256` entries of the
  cacophony/snow vector files (A5); QA re-checks the RFC values above against the RFC text.
- Decision canonicalisation: `{"agent_device_id":"a","expires_at":300,"issued_at":0,"kind":"allow",
  "payload":null,"phone_device_id":"p","request_hash":"00…00","request_id":"r","v":1}` must hash to
  one frozen SHA-256 recorded in the test on first run and never changed without a protocol bump.

## 8. Open questions for the owner

- Q1. Passkeys only, no email at all (so no password reset, one recovery code)? Default: yes.
- Q2. Agent enrollment token: pasted `rc-enroll:` string vs embedded in the pairing QR (larger QR,
  one step fewer). Default: pasted string; QR stays small enough for terminals.
- Q3. UV on `AskUserQuestion` answers (they steer the session but execute nothing directly)?
  Default: yes, same class as Allow.
- Q4. If report 05 finds UV unusable in the installed iOS PWA: accept a 2-minute re-auth window
  after a browser-tab login, or block Allow on iOS until native? Default: window, iOS only, labelled.
- Q5. Session cookie lifetime: 7 d idle / 30 d absolute (proposed) vs OWASP-short. Default: proposed.
- Q6. Invite-code registration at launch (abuse control, no email)? Default: yes, remove later.
- Q7. Agent key storage: plain 0600 file (MVP) vs OS keychain (macOS `security`, later). Default: file.

## 9. Sources

- https://caniuse.com/mdn-api_subtlecrypto_derivekey_x25519
- https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey
- https://developer.mozilla.org/en-US/docs/Web/API/CryptoKey
- https://developer.mozilla.org/en-US/docs/Web/API/AuthenticatorAssertionResponse/signature
- https://developer.mozilla.org/en-US/docs/Web/API/Push_API
- https://nodejs.org/api/webcrypto.html
- https://nodejs.org/api/permissions.html
- https://noiseprotocol.org/noise.html
- https://github.com/paulmillr/noble-curves, https://github.com/paulmillr/noble-ciphers
- https://registry.npmjs.org/@noble/curves/latest, …/noise-handshake/latest, …/@chainsafe/libp2p-noise/latest, …/libsodium-wrappers-sumo/latest
- https://registry.npmjs.org/@simplewebauthn/server/latest, …/@simplewebauthn/browser/latest
- https://simplewebauthn.dev/docs/packages/server
- https://raw.githubusercontent.com/MasterKale/SimpleWebAuthn/master/packages/server/src/authentication/generateAuthenticationOptions.ts
- https://raw.githubusercontent.com/MasterKale/SimpleWebAuthn/master/packages/server/src/authentication/verifyAuthenticationResponse.ts
- https://www.w3.org/TR/webauthn-3/#sctn-op-get-assertion (truncated fetch; MDN used for F9)
- https://passkeys.dev/device-support/
- https://github.com/w3c/webauthn/wiki/Explainer:-PRF-extension (moved; not relied upon)
- https://code.claude.com/docs/en/hooks, https://code.claude.com/docs/en/permissions, https://code.claude.com/docs/en/settings
- https://code.claude.com/docs/en/agent-sdk/overview
- https://raw.githubusercontent.com/Louis-CFM/coucou/main/docs/IPHONE.md, …/docs/ANDROID_LINK.md, …/docs/RELAY_LINK.md, …/android/README.md
- https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- https://webkit.org/blog/13966/webkit-features-in-safari-16-4/
- https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/
- https://www.rfc-editor.org/rfc/rfc8291
- https://registry.npmjs.org/web-push/latest
- https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- https://registry.npmjs.org/@fastify/cookie/latest, …/@fastify/csrf-protection/latest, …/@fastify/rate-limit/latest, …/@fastify/websocket/latest
- https://docs.railway.com/guides/postgresql, https://docs.railway.com/guides/private-networking
- https://docs.npmjs.com/generating-provenance-statements, https://docs.npmjs.com/trusted-publishers/
- https://docs.github.com/en/actions/concepts/security/artifact-attestations
- https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection
- https://pnpm.io/settings/dependency-resolution
- https://gdpr-info.eu/art-17-gdpr/
- Local: `/Users/ivanbaev/Development/agenthropic/SECURITY.md`, `/Users/ivanbaev/Development/agenthropic/docs/independent-due-diligence.md`
