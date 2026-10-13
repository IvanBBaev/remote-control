# ADR 0001 — Push summary key

Status: accepted, M1-06 · Reviewed against: 02 §5.2, D5

A push may name the project, the tool's plain label and one secret-masked line (05 Rec-1),
sealed so that the relay never reads it (I3). Each pairing derives a notification key on
both ends: `HKDF-SHA-256(X25519(own static, peer static), salt = empty, info =
"rc/v1/push")`, imported as a non-extractable AES-256-GCM key, encrypt-only on the agent
and decrypt-only in the phone's IndexedDB for the service worker. The agent seals at most
1 KiB (random 96-bit nonce, AAD = `"rc/v1/push" || envelope id`, so a summary cannot be
moved to another push) into the request header's `pushBlob`, which the Noise transport
AEAD authenticates; the relay copies it verbatim into the push payload (≤ 3.5 KB) and
never logs, stores or decodes it. Against 02 §5.2: the key is static, so summaries have
no forward secrecy — accepted, because they never carry file contents or secrets and the
key rotates whenever the pair re-pairs; it never protects session traffic, which keeps
Noise KK with ephemeral DHs, and the separate HKDF `info` keeps the two keys independent
although both use the static–static DH. Any failure (no key, a browser that cannot store
a `CryptoKey`, a blob that does not open) falls back to the generic metadata
notification, which is always shown.
