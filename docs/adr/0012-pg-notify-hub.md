# ADR 0012 — `PgNotifyHub`: two relay replicas over Postgres LISTEN/NOTIFY

Status: accepted (M3 backlog item "`PgNotifyHub` + 2 replicas", 03 W11, 2026-10-14)
Deviates from: nothing. D15 names a `PgNotifyHub` on LISTEN/NOTIFY as the path to two
replicas. This ADR records its shape and rejects 03's outbox variant, as D4 already does.

## Context

With `LocalHub`, a phone and its agent must reach the same replica. A second replica
(zero-downtime deploys, failover) needs a hub that spans replicas. D15 rules out Redis,
and D4 rules out storing messages. Postgres is already deployed. Its `NOTIFY` carries
payloads under 8000 bytes, through a transient in-memory queue, and delivers them on
commit, in order (03 F24–F26).

## Decision

- **Port seam.** `HubPort` keeps its synchronous API. `PgNotifyHub` implements it with a
  `LocalHub` for the replica's own sockets and a proxy `HubConnection` for each device on
  another replica. Under the proxy, `send` and `close` are a `NOTIFY` to the owning
  replica. `RelayRouter` and the rest of the core do not change, except for one optional
  seam, `HubPort.cluster`:
  - **acks fan out**, because the sender's replica tracks a delivery;
  - **devices of a vanished replica are reported offline** to the local peers.
- **Adapter.** `NotifyBus` is the adapter port:
  - production: `pg`. One dedicated `LISTEN` client per replica, re-opened after a
    drop, and one dedicated `NOTIFY` client. Neither uses a slot of the request pool.
  - tests and the harness: PGlite.
  - core tests: an in-memory network.
- **Channels.** `rc_hub` carries membership: `hello`, `hb`, `bye`, `on`, `off`, `ack`.
  `rc_hub_<replica id>` carries the traffic for that replica's devices: `tx` and
  `close`. The replica id is 8 random bytes per process.
- **Large frames.** A frame larger than 7900 bytes as one notification is sent
  base64-chunked. All the chunks go in one transaction, so they arrive together and
  in order. Publishes are serialised per replica, so `on` → `close` (a supersede) and
  `tx` sequences keep their order.
- **Supersede across replicas.** When a replica hears `on` for a device it holds, it
  forgets the local socket silently and keeps it as _displaced_. The new replica's
  4000 `close` then reaches that socket, and its own `closed()` reports no offline
  presence.
  _(Amended after the M3 review, 2026-10-16.)_ Each `on` carries its attach time `a`.
  A replica that attaches a device another replica already holds stamps it
  `max(now, remote a + 1)`, so a supersede is always later than what it replaces.
  When two claims meet, the later `a` wins and a tie goes to the larger replica id;
  a replica whose local socket is newer answers a stale `on` with its own `on`
  instead of giving the socket up, so both sides settle on the same holder.
- **Device cap.** It counts local and remote devices (D15's cap of 10 per user holds
  cluster-wide).
- **Liveness.**
  - Heartbeat every 5 s; a replica silent for 15 s is dropped and its devices are
    reported offline.
  - On `SIGTERM` the replica says `bye` before the database closes, and the others
    drop its devices without presence noise. The devices reconnect, and they are
    announced again from wherever they land.
  - After a `LISTEN` reconnect, the replica forgets every remote device it knew and
    sends `hello` followed by its `on`s in one transaction. A `hello` replaces the
    receiver's view of the sender: devices the sender no longer announces are
    dropped, and the receiver answers with its own `hello` and `on`s directly.
  - A replica that hears anything but `hello` from a replica it does not know (it
    had dropped it as silent) announces itself to that replica directly. A failed
    publish makes the next heartbeat a full announce instead of `hb`.
- **Configuration.** `RC_HUB=pg` (requires a database URL) selects it; the default
  stays `local`.

## Why this keeps D4 and I1/I2

Frames reach the hub already encrypted end to end. A frame that crosses replicas is
stored in no table. It passes through Postgres' notification queue, which holds it in
memory until every listener has read it, and then discards it. That is the same
exposure as the replica's own socket buffers. Payloads are never logged; hub log lines
carry event names and error codes only. The hub holds no authority: it relays frames,
and every check stays where it was.

## Rejected

- **03's outbox (a `messages` table claimed with `SKIP LOCKED`).** It stores payloads,
  which D4 forbids, and it adds retention and cleanup that the no-outbox design avoids.
- **Redis pub/sub.** It is another service to run and secure (D15).
- **Sticky routing at the edge.** Railway cannot pin a user's devices to one replica.

## Consequences and limitations

- **No backpressure across replicas.** A proxy `send` returns `true` once queued, so
  a slow remote socket is not reported as `rate_limited` to the sender. Its own replica
  still applies backpressure to its socket. Unacked frames are re-sent by the sender
  (D4).
- **Gaps after a lost `LISTEN` connection.** A frame sent while a replica's `LISTEN`
  connection is down is lost. The resync restores membership, not frames; the
  sender's re-send covers them.
- **Postgres' 8 GB notification queue.** A listener that stops reading fills the queue
  and blocks `NOTIFY` for every replica. Listeners read continuously, and a stuck
  replica is restarted by its health check.
- **Dead replicas.** Presence for a dead replica's devices can lag by up to 15 s.
- **No staging run yet.** Two real replicas on Railway have not been exercised. The
  harness runs two relays on one PGlite (`replicas.test.ts`). `pg-real` runs two hubs
  on a real Postgres 17, each with its own `LISTEN` and `NOTIFY` connections. ADR 0016
  adds the staging environment and its runbook procedure.
- **WebAuthn state was per replica.** A ceremony or decision step-up whose calls landed
  on two replicas failed. ADR 0016 moves it into Postgres under `RC_HUB=pg`.
