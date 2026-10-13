# ADR 0010 — Agent-side assertion check: key provenance, legacy peers, no passkey add

Status: accepted (M2-03, 2026-10-13)
Deviates from: ROADMAP M2-03 scope ("shared … at pairing and on passkey add") and
02 §5.4 (the assertion "travels in the clear beside the encrypted decision")

## Context

D7 phase 2 (02 §5.4, W15) closes the "malicious relay + unlocked phone" residual risk:
the agent itself verifies the ES256 signature of each decision's WebAuthn assertion
instead of trusting the relay's `verified` flag. That needs the passkey's public key on
the agent and the assertion in front of the agent.

Three questions are open in the sources: how the public key reaches the agent without
the relay being able to swap it, what happens to computers paired before M2-03 (they
hold no key), and what "on passkey add" means when the web app has no add-passkey flow
yet.

## Decision

- **Key provenance.** The phone keeps the SPKI that `getPublicKey()` returns at
  registration (A3), per account, in `localStorage` (`rc.auth.passkeys`, at most 16 per
  account; public keys only). It sends them, with the rp id, in pairing msg3
  (`PhonePairingHello.passkeys`). msg3 is encrypted and authenticated under XXpsk0 with
  the pairing code, so the relay can neither read nor replace the keys (I1, I3).
- **Assertion inside the envelope.** The assertion now travels inside the encrypted
  decision (`assertion` on Decision, Start and Instruct), not beside it. The relay still
  sees only the decision hash it is asked to challenge.
- **Agent check.** For a peer that handed over passkeys, the agent checks, after the
  D7 order up to the peer: known credential, `clientDataJSON.type == "webauthn.get"`,
  challenge equals base64url(SHA-256(canonical decision)), `rpIdHash == SHA-256(rpId)`,
  UV flag, ES256 signature over `authenticatorData || SHA-256(clientDataJSON)`, and a
  strictly growing signature counter when either side is non-zero. A failure is
  refused as `unverified` and logged as `assertion_refused` with its reason. The
  envelope's relay `verified` flag is not consulted for such a peer.
- **Counter persistence.** The hub keeps the last counter per credential in memory and
  persists it through `recordPasskeyUse` into `peers.json`; a stored counter is the
  floor after a restart. Counters stay 0 for authenticators that never count (synced
  passkeys); decide-once and the relay's used-challenge set cover replay there.
- **Legacy peers.** A peer paired without passkeys (before M2-03, or a phone whose
  storage lost them) keeps the phase-1 path: the envelope `decisionHash` must match the
  recomputed hash, i.e. the relay vouched for it. `remotectl pair` warns when the phone
  sent no keys; re-pairing upgrades the peer.
- **No "on passkey add".** The web app has no add-passkey flow, so there is nothing to
  hook. A new passkey reaches a computer by re-pairing. When an add flow is built, it
  must deliver the new key over an existing KK session, never through the relay.
- **Relay unchanged.** The relay keeps verifying assertions and the challenge set as
  defence in depth; nothing in its schema or routes changes.
- **Harness.** `scenario({ relayCheck: false })` lets the headless phone sign the
  decision challenge locally and skip the relay's challenge/verify, which proves J2 on
  the agent's check alone (ROADMAP AC).

## Consequences

- A fake relay that forwards a tampered or replayed assertion is refused by the agent
  (W15 AC); a relay that forges `verified` gains nothing against an upgraded peer.
- Old pairings stay on relay trust until re-paired; the warning at pair is the only
  nudge. A later WP may refuse legacy peers outright.
- Clearing site data on the phone drops its keys; the next pairing then falls back to
  the legacy path with a warning, never fails.
