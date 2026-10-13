# ADR 0009 — Revocation and account deletion: shape and build ahead of the real-CLI check

Status: accepted (M1-10, 2026-10-13)
Deviates from: 02 §5.9 (audit retention on deletion, `account_deleted` on next connect,
inactive purge) and ROADMAP §4 dependency order (M1-10 depends on M1-07, whose real-CLI
check is pending, ADR 0007)

## Context

02 §5.9 asks for phone and agent revocation and a one-endpoint account deletion with UV,
a cascade delete, and agents that "receive `account_deleted` on next connect". It also
keeps audit events for 90 days and deletes inactive accounts after 12 months. The
ROADMAP AC for M1-10 adds a schema-wide check: after deletion, no relay row names the
user.

A tombstone row that answers an offline agent with `account_deleted` would be a row
that names the user, which the AC forbids. 90-day audit rows also name the user. M1-07
is `doing` only because its real-CLI log is pending (ADR 0007). Nothing in M1-10 depends
on that log, so the code does not wait for it (as with ADR 0005 and ADR 0007).

## Decision

- **Revoke.** `DELETE /api/devices/:deviceId` takes the phone cookie (any device of the
  account) or the agent bearer (phones only; `remotectl devices revoke <id>`). In one
  transaction it marks the device and its pairings revoked. It deletes the device's login
  sessions, push subscriptions, agent token and pairing slots, and writes a
  `device_revoked` audit row. The live socket closes with 4002 `revoked`. Every live agent
  of the account gets `peer_revoked`, and the relay replays revoked pairings to an agent
  after each `hello_ok`. An unknown or already revoked device answers 404 either way.
- **Agent side.** The CLI forgets the phone's key before it asks the relay. On
  `peer_revoked`, the hub ends that phone's session, refuses its handshakes and
  re-snapshots the other phones, and the key is removed from `peers.json`. A revoked
  agent (4002, or a refused upgrade followed by 401 from `GET /api/agents/me`) stops
  reconnecting for good and drops every peer.
- **Delete.** The phone signs `accountDeletionHash(userId)` with a user-verifying
  assertion through `/api/decisions/challenge` and `/verify`, then calls
  `DELETE /api/account`. The relay consumes the verification and deletes every row of
  the user, **audit rows included**. It closes every socket with 4002 `account_deleted`
  and clears the cookie. Without a fresh verification for that hash, it answers 403
  `not_verified`.
- **No tombstone.** An agent that was offline during deletion learns of it on its next
  connect, from the 401 at `/api/agents/me`. It reports `revoked` instead of
  `account_deleted`.
- **Phone.** On a 4002 close the PWA stops reconnecting, forgets its machines and signs
  out. Deletion forgets the machines even when the socket was already closed.
- **Deferred.** The 12-month inactive purge is not part of M1-10. It needs the scheduled
  job that M0-26b's operations work brings.

## Consequences

- Deleting an account also erases its audit trail. An operator cannot reconstruct a
  deleted account's history, which matches the "no row for the user" promise on the
  privacy page.
- An offline agent cannot tell revocation from deletion. Both lead to the same next step
  (`remotectl login` with a new token).
- A phone in the `joining` pairing phase has no routed socket to close. Its slot is
  deleted, so the join fails.
- Another phone's `/machines` list drops a revoked phone when the agent re-snapshots,
  and drops a revoked agent when the next device report arrives.
- If the real-CLI check (M0-23) contradicts M1-07, a follow-up ADR covers it. M1-10 does
  not change.
