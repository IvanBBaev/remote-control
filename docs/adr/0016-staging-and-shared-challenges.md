# ADR 0016 — Staging with two replicas, and WebAuthn challenges shared in Postgres

Status: accepted (M3 backlog item "staging environment", 06 §5.6, 2026-10-14)
Deviates from:

- D16's "no staging until a second real user" and "1 replica", for the staging
  environment only. Production keeps one replica.
- D15's in-process challenge state, when `RC_HUB=pg`.

## Context

ADR 0012 lets a phone and its agent sit on different replicas, but it left one gap,
and two real replicas have never run.

The gap is the WebAuthn state, which lived in process: registration, login and recovery
challenges, plus the decision step-up (D7, 02 §5.4). A load balancer spreads a phone's
HTTP calls over replicas, so a ceremony can start on one replica and finish on another.
The second replica then answers `unknown_challenge`, and the same holds for a decision.
Its hash is verified over HTTP on one replica, but the command that names it is admitted
on whichever replica holds the phone's socket. The harness shows the failure: with the
phone's calls alternating between two relays, registration fails at
`/api/auth/register/verify`.

Railway cannot pin a client to a replica, and D15 rules out Redis.

## Decision

### Shared challenge state

- **Port.** A `ChallengeLedger` port holds both kinds of state: outstanding challenges
  (`put`, then a single-use `take`) and verified decision hashes (`usage`,
  `markVerified`, `isVerified`, `consume`). `AccountService` and `DecisionVerifier`
  both use it.
- **Adapters.**
  - `MemoryChallengeLedger` (bounded, as before) when `RC_HUB=local`.
  - `createDrizzleChallengeLedger` when `RC_HUB=pg`.
  - The container picks the adapter with the hub, so one switch moves the relay to
    multi-replica.
- **Tables.** The migration is `0003_shared_challenges`.
  - `webauthn_challenges`:
    - key: the base64url challenge, or `decision:<user>:<device>:<challenge>`;
    - `kind`;
    - the ids the ceremony needs: invite, WebAuthn user handle, display name,
      recovery code, user, device;
    - the decision hash;
    - `expires_at`: 5 minutes, the challenge TTL.
  - `verified_decisions`: one row per decision hash, holding:
    - user and device;
    - `used_until`: 10 minutes, the replay window;
    - `verified_until`: 5 minutes, the admission window; `NULL` once spent.

  The tables have no foreign keys, because a row outlives nothing it names by more
  than 10 minutes. They store ids, a hash and expiry times, never a payload (I3).
  `schema-introspection` lists both tables, so the I3 schema check covers them.

- **Atomicity.**
  - `take` is a `DELETE … RETURNING`, so of two replicas taking the same challenge,
    one gets it.
  - `markVerified` is an `INSERT … ON CONFLICT DO UPDATE … WHERE used_until <= now`, so
    of two concurrent verifies of one hash, one wins and the other answers
    `replayed`.
  - `consume` is an `UPDATE … WHERE` the admission window is open `RETURNING`, so a
    hash is spent once.
  - Expired rows are swept before each insert.
  - Every time comes from the Clock port, never from the database's `now()`.
- **Admission.** `CommandGate.admit` may now return a `Promise`. `RelayRouter` awaits it
  only then, and each socket routes one frame at a time, so a frame waits for the
  admission of the frame before it and the order of a sender's frames does not change.
  A failed admission query answers `unverified` and the next frame is routed.
  (Amended after review: the in-memory ledger answers with a `Promise` too, so the
  first version reordered frames on one replica as well.)

### Rate limits

The fixed-window rate limiters stay in process, per replica. With N replicas a client
can get up to N times each limit. The limits are abuse bounds, not quotas. Two replicas
double them at worst, which they tolerate, and sharing them would cost a database write
on every request.

### Staging

- A Railway environment `staging` in the same project, with its own Postgres and
  domain. It deploys the `staging` branch.
- `numReplicas: 2` and `RC_HUB=pg`. `railway.json` records the replica override under
  `environments.staging`. Config as Code stops being read on 2026-12-01, so the
  dashboard setting is authoritative.
- It has its own secrets, VAPID keys and RP id. It never shares a value with production.
- The procedure is in `docs/ops/runbook.md#staging`.
- Locally, `RC_HUB=pg docker compose --profile replicas up` runs the same shape on
  ports 3000 and 3001.

## Why this keeps I1–I4

- **I1 and I2.** The relay already saw every value in these tables in process: ids, the
  decision hash it builds the challenge from, and expiry times. Moving them to Postgres
  exposes no plaintext.
- **I3.** No payload is stored.
- **I4.** The ledger records that a phone's passkey signed a hash. The agent still runs
  every D7 check and decide-once. The relay grants nothing.

## Rejected

- **Stateless signed challenges** (an HMAC over the challenge and its expiry, checked by
  any replica). This needs no table for outstanding challenges, but single use and the
  replay window still need shared state. It also adds a signing key to rotate.
- **Sticky sessions.** Railway cannot pin a client to a replica (ADR 0012).
- **Shared rate limits.** They add a write per request for a bound that tolerates 2×.
- **Redis.** Ruled out by D15.

## Consequences and limitations

- **Database round trips under `RC_HUB=pg`**: one per command that names a
  `decisionHash`, and a few per WebAuthn ceremony.
- **A slow admission query holds the sender's later frames** under `RC_HUB=pg`: they
  wait for it instead of overtaking it, so a deny never overtakes an allow it followed.
- **A database outage blocks sign-in and step-up** under `RC_HUB=pg`. `/health` already
  reports `degraded` then.
- **Staging adds cost.** The staging environment adds its own usage (two replicas and a
  Postgres) to the bill, under the same usage alert and hard limit. Stop it when no run
  is planned.
- **The two-replica run is still pending.** It is the owner's step, in the runbook. Until
  it is recorded there, the evidence is:
  - the harness: two relays on one PGlite, with the phone's HTTP calls alternating
    between them (`replicas.test.ts`);
  - the ledger tests: two ledgers over one database.
