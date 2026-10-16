import {
  encodeFrame,
  negotiateVersion,
  parseFrame,
  VERSION_TABLE,
  type Clock,
  type Envelope,
  type Frame,
  type Hello,
  type PresenceEntry,
  type RelayErrorCode,
} from '@remote-control/protocol';
import type { Logger } from 'pino';

import type { DeviceDirectory, DeviceIdentity } from '../ports/device-directory.js';
import type { DeviceRevocations } from '../ports/device-revocations.js';
import type { HubConnection, HubPort } from '../ports/hub.js';
import type { PeerSocket } from '../ports/peer-socket.js';
import {
  admitAllCommands,
  ignoreAudit,
  ignorePendingRequests,
  type AuditSink,
  type CommandGate,
  type PendingRequestSink,
} from '../ports/relay-seams.js';
import type { Timer, TimerHandle } from '../ports/timer.js';
import { AckTracker } from './ack-tracker.js';
import {
  BACKPRESSURE_BYTES,
  CLOSE_GRACE_MS,
  CloseCode,
  FRAMES_PER_SECOND,
  HELLO_TIMEOUT_MS,
  LAST_SEEN_INTERVAL_MS,
  PING_INTERVAL_MS,
  SILENCE_LIMIT_MS,
} from './hub-limits.js';
import { TokenBucket } from './token-bucket.js';

/** Largest presence snapshot `hello_ok` carries (D14). */
const MAX_PRESENCE = 32;
/** Frames a socket may send between `hello` and `hello_ok`; they are replayed after it. */
const MAX_EARLY_FRAMES = FRAMES_PER_SECOND;

export interface RelayRouterDeps {
  readonly clock: Clock;
  readonly timer: Timer;
  readonly hub: HubPort;
  readonly directory: DeviceDirectory;
  readonly logger: Logger;
  readonly commandGate?: CommandGate;
  readonly pending?: PendingRequestSink;
  readonly audit?: AuditSink;
  /** Revoked pairings replayed to an agent after `hello_ok` (M1-10); none when absent. */
  readonly revocations?: Pick<DeviceRevocations, 'revokedPeers'>;
}

/** Counters for metrics and tests; headers only (I3). */
export interface RelayStats {
  /** Envelopes addressed to a device of another user (or no device at all), dropped. */
  crossTenantDrops: number;
  /** Envelopes not sent because the recipient's socket had > 1 MiB queued. */
  backpressureDrops: number;
}

/** What the transport adapter calls for one accepted socket. */
export interface SocketEvents {
  /** A text message (`string`) or a binary one (`null`, always refused). */
  message(data: string | null): void;
  /** A protocol-level pong. */
  pong(): void;
  /** The socket is gone (closed or terminated). */
  closed(): void;
}

type Phase = 'awaiting_hello' | 'joining' | 'open' | 'closed';

/**
 * The relay's message core (D14, D15, 03 §5): authenticated sockets go through
 * `hello` → `hello_ok`, then their envelopes are routed by header to devices of the same
 * user only. Payloads are opaque and never logged or stored (I1, I2, D4, D19).
 */
export class RelayRouter {
  readonly stats: RelayStats = { crossTenantDrops: 0, backpressureDrops: 0 };
  readonly #sessions = new Set<DeviceSession>();
  readonly #acks: AckTracker;
  readonly #gate: CommandGate;
  readonly #pending: PendingRequestSink;
  readonly #audit: AuditSink;
  #draining = false;

  constructor(readonly deps: RelayRouterDeps) {
    this.#gate = deps.commandGate ?? admitAllCommands;
    this.#pending = deps.pending ?? ignorePendingRequests;
    this.#audit = deps.audit ?? ignoreAudit;
    this.#acks = new AckTracker(deps.timer, (delivery) => this.#pending.unacked(delivery));
    deps.hub.cluster?.bind({
      ack: (userId, recipientId, ids) => this.#settle(userId, recipientId, ids),
      lost: (device, localPeers) => this.#announce(device, false, localPeers),
    });
  }

  /** Starts serving an upgraded socket whose identity was established before the upgrade. */
  accept(identity: DeviceIdentity, socket: PeerSocket): SocketEvents {
    const session = new DeviceSession(this, identity, socket);
    this.#sessions.add(session);
    return session;
  }

  /** Sockets currently open (any phase). */
  get openSockets(): number {
    return this.#sessions.size;
  }

  /** Deliveries awaiting an ack. */
  get trackedDeliveries(): number {
    return this.#acks.size;
  }

  get draining(): boolean {
    return this.#draining;
  }

  /**
   * Shutdown (D15, 03 §5.13): closes every socket with 1012, terminates the ones that do
   * not finish the closing handshake within {@link CLOSE_GRACE_MS}, stamps `last_seen_at`
   * of every connected device and forgets every ack timer.
   */
  async drain(): Promise<number> {
    this.#draining = true;
    const sessions = [...this.#sessions];
    const seen = sessions.filter((session) => session.attached).map((s) => s.identity.deviceId);
    for (const session of sessions) session.shutdown();
    this.#acks.clear();
    const now = this.deps.clock.now();
    await Promise.all(seen.map((deviceId) => this.markSeen(deviceId, now)));
    return sessions.length;
  }

  /** @internal */
  forget(session: DeviceSession): void {
    this.#sessions.delete(session);
  }

  /** @internal Writes `last_seen_at`; a failure is logged, never thrown. */
  async markSeen(deviceId: string, now: number): Promise<void> {
    try {
      await this.deps.directory.markSeen(deviceId, now);
    } catch (error) {
      this.deps.logger.warn(
        { event: 'last_seen_failed', device_id: deviceId, err: error },
        'could not write last_seen_at',
      );
    }
  }

  /** @internal The `hello_ok` presence snapshot: the user's other live devices. */
  async presenceSnapshot(identity: DeviceIdentity): Promise<PresenceEntry[]> {
    const now = this.deps.clock.now();
    const devices = await this.deps.directory.listDevices(identity.userId);
    return devices
      .filter((device) => device.revokedAt === null && device.id !== identity.deviceId)
      .slice(0, MAX_PRESENCE)
      .map((device) => {
        const online = this.deps.hub.connection(identity.userId, device.id) !== undefined;
        return {
          deviceId: device.id,
          kind: device.kind,
          name: device.name.slice(0, 64) || device.kind,
          online,
          lastSeen: online ? now : device.lastSeenAt,
        };
      });
  }

  /** @internal Tells the user's other devices that `identity` came online or left. */
  broadcastPresence(identity: DeviceIdentity, online: boolean): void {
    this.#announce(identity, online, this.deps.hub.connections(identity.userId));
  }

  #announce(identity: DeviceIdentity, online: boolean, peers: readonly HubConnection[]): void {
    if (this.#draining) return;
    const text = encodeFrame({
      v: VERSION_TABLE.v,
      kind: 'presence',
      deviceId: identity.deviceId,
      online,
      at: this.deps.clock.now(),
    });
    for (const peer of peers) {
      if (peer.identity.deviceId !== identity.deviceId) peer.send(text);
    }
  }

  /** @internal Routes one envelope from `sender` (already parsed; `text` is forwarded as is). */
  async route(sender: DeviceSession, envelope: Envelope, text: string): Promise<void> {
    const { identity } = sender;
    if (envelope.from !== identity.deviceId || envelope.to === identity.deviceId) {
      sender.error('bad_frame', envelope.id, 'sender or recipient does not match the socket');
      return;
    }
    const now = this.deps.clock.now();
    if (envelope.expiresAt !== null && envelope.expiresAt <= now) {
      sender.error('expired', envelope.id, 'envelope expired');
      return;
    }
    if (envelope.cls === 'command') {
      // The gate may answer asynchronously (ADR 0016); DeviceSession routes one frame at a
      // time, so a command is not overtaken by the sender's next frame.
      let admitted: boolean;
      try {
        const answer = this.#gate.admit(envelope, identity);
        admitted = typeof answer === 'boolean' ? answer : await answer;
      } catch (error) {
        this.deps.logger.error(
          {
            event: 'gate_failed',
            device_id: identity.deviceId,
            envelope_id: envelope.id,
            err: error,
          },
          'decision check failed',
        );
        sender.error('unverified', envelope.id, 'decision could not be checked');
        return;
      }
      if (!admitted) {
        this.deps.logger.warn(
          {
            event: 'command_refused',
            reason: 'unverified',
            user_id: identity.userId,
            device_id: identity.deviceId,
            envelope_id: envelope.id,
          },
          'command without a verified decision dropped',
        );
        sender.error('unverified', envelope.id, 'decision not verified');
        return;
      }
    }
    if (envelope.to === null) {
      for (const peer of this.deps.hub.connections(identity.userId)) {
        if (peer.identity.deviceId !== identity.deviceId)
          this.#deliver(sender, peer, envelope, text);
      }
      return;
    }
    const target = this.deps.hub.connection(identity.userId, envelope.to);
    if (target !== undefined) {
      this.#deliver(sender, target, envelope, text);
      return;
    }
    const owner = await this.deps.directory.ownerOf(envelope.to);
    if (owner === identity.userId) {
      this.#pending.undelivered({
        envelopeId: envelope.id,
        userId: identity.userId,
        from: identity.deviceId,
        to: envelope.to,
        cls: envelope.cls,
        expiresAt: envelope.expiresAt,
        ...(envelope.pushBlob === undefined ? {} : { pushBlob: envelope.pushBlob }),
      });
      return;
    }
    this.stats.crossTenantDrops += 1;
    this.deps.logger.warn(
      {
        event: 'envelope_dropped',
        reason: owner === undefined ? 'unknown_device' : 'cross_tenant',
        user_id: identity.userId,
        device_id: identity.deviceId,
        envelope_id: envelope.id,
      },
      'envelope for a device outside the user dropped',
    );
    sender.error('unknown_device', envelope.id, 'unknown recipient');
  }

  /** @internal Forwards the recipient's `ack` to each original sender (D4). */
  forwardAck(recipient: DeviceSession, ids: readonly string[]): void {
    const { userId, deviceId } = recipient.identity;
    this.#settle(userId, deviceId, ids);
    // The envelope may have been routed (and tracked) by another replica (ADR 0012).
    this.deps.hub.cluster?.publishAck(userId, deviceId, ids);
  }

  #settle(userId: string, recipientId: string, ids: readonly string[]): void {
    const bySender = this.#acks.ack(recipientId, ids);
    for (const [from, settled] of bySender) {
      this.deps.hub
        .connection(userId, from)
        ?.send(encodeFrame({ v: VERSION_TABLE.v, kind: 'ack', ids: settled }));
    }
  }

  #deliver(sender: DeviceSession, target: HubConnection, envelope: Envelope, text: string): void {
    if (!target.send(text)) {
      this.stats.backpressureDrops += 1;
      sender.error('rate_limited', envelope.id, 'recipient is not reading');
    } else if (envelope.cls === 'command' && envelope.decisionHash !== undefined) {
      this.#audit.decisionForwarded(sender.identity, envelope.decisionHash);
    }
    this.#acks.track({
      envelopeId: envelope.id,
      userId: sender.identity.userId,
      from: sender.identity.deviceId,
      to: target.identity.deviceId,
      watch: envelope.cls === 'request' && target.identity.kind === 'phone',
      expiresAt: envelope.expiresAt,
      ...(envelope.pushBlob === undefined ? {} : { pushBlob: envelope.pushBlob }),
    });
  }
}

/** One socket's state machine: hello deadline, rate limit, heartbeat, dispatch. */
class DeviceSession implements HubConnection, SocketEvents {
  #phase: Phase = 'awaiting_hello';
  #attached = false;
  #lastActivity: number;
  #lastMarkedAt: number;
  #helloTimer: TimerHandle | undefined;
  #heartbeat: TimerHandle | undefined;
  #terminator: TimerHandle | undefined;
  readonly #bucket: TokenBucket;
  readonly #early: string[] = [];
  /** The last routed frame; the next one waits for it so a sender's order holds. */
  #routing: Promise<void> | undefined;

  constructor(
    private readonly router: RelayRouter,
    readonly identity: DeviceIdentity,
    private readonly socket: PeerSocket,
  ) {
    const { clock, timer } = router.deps;
    this.#lastActivity = clock.now();
    this.#lastMarkedAt = this.#lastActivity;
    this.#bucket = new TokenBucket(clock, {
      capacity: FRAMES_PER_SECOND,
      perSecond: FRAMES_PER_SECOND,
    });
    this.#helloTimer = timer.after(HELLO_TIMEOUT_MS, () => {
      if (this.#phase === 'awaiting_hello') this.close(CloseCode.policy, 'hello timeout');
    });
    this.#scheduleHeartbeat(PING_INTERVAL_MS);
  }

  get attached(): boolean {
    return this.#attached;
  }

  // ── HubConnection ────────────────────────────────────────────────────────────────

  send(text: string): boolean {
    if (this.#phase === 'closed' || this.socket.bufferedAmount > BACKPRESSURE_BYTES) return false;
    this.socket.send(text);
    return true;
  }

  close(code: number, reason: string): void {
    if (this.#phase === 'closed') return;
    this.#phase = 'closed';
    this.#stopTimers();
    this.socket.close(code, reason);
    this.#terminator = this.router.deps.timer.after(CLOSE_GRACE_MS, () => this.socket.terminate());
  }

  /** Drain: 1012 without presence broadcasts (the whole replica is going away). */
  shutdown(): void {
    this.close(CloseCode.serviceRestart, 'service restart');
  }

  // ── SocketEvents ─────────────────────────────────────────────────────────────────

  message(data: string | null): void {
    if (this.#phase === 'closed') return;
    if (!this.#bucket.take()) {
      this.close(CloseCode.policy, 'rate limited');
      return;
    }
    this.#lastActivity = this.router.deps.clock.now();
    if (data === null) {
      this.close(CloseCode.policy, 'binary frames are not accepted');
      return;
    }
    if (this.#phase === 'joining') {
      if (this.#early.length >= MAX_EARLY_FRAMES) this.close(CloseCode.policy, 'too early');
      else this.#early.push(data);
      return;
    }
    this.#dispatch(data);
  }

  pong(): void {
    this.#lastActivity = this.router.deps.clock.now();
  }

  closed(): void {
    const wasClosed = this.#phase === 'closed';
    this.#phase = 'closed';
    this.#stopTimers();
    this.#terminator?.cancel();
    this.router.forget(this);
    if (!this.#attached) return;
    this.#attached = false;
    if (!this.router.deps.hub.detach(this) || (wasClosed && this.router.draining)) return;
    this.router.broadcastPresence(this.identity, false);
    void this.router.markSeen(this.identity.deviceId, this.router.deps.clock.now());
  }

  /** Sends an `error` frame (never closes). */
  error(code: RelayErrorCode, ref: string | null, message: string): void {
    this.send(encodeFrame({ v: VERSION_TABLE.v, kind: 'error', code, ref, message }));
  }

  // ── internals ────────────────────────────────────────────────────────────────────

  #dispatch(text: string): void {
    const parsed = parseFrame(text);
    if (!parsed.ok) {
      if (parsed.error.code === 'unsupported_version') {
        this.error('unsupported_version', null, 'unsupported protocol version');
      }
      this.close(parsed.error.closeCode, parsed.error.code);
      return;
    }
    const frame: Frame = parsed.frame;
    if (this.#phase === 'awaiting_hello') {
      if (frame.kind === 'hello') void this.#hello(frame);
      else this.close(CloseCode.policy, 'expected hello');
      return;
    }
    switch (frame.kind) {
      case 'data':
        this.#route(frame, text);
        return;
      case 'ack':
        this.router.forwardAck(this, frame.ids);
        return;
      case 'ping':
        this.send(
          encodeFrame({
            v: VERSION_TABLE.v,
            kind: 'pong',
            t: frame.t,
            relayTs: this.router.deps.clock.now(),
          }),
        );
        return;
      default:
        // A second `hello`, or a frame only the relay may send.
        this.close(CloseCode.policy, 'unexpected frame');
    }
  }

  /** Routes `frame` now, or after the previous frame if that one is still awaiting. */
  #route(frame: Envelope, text: string): void {
    const run = (): Promise<void> =>
      this.router.route(this, frame, text).catch((error: unknown) => {
        this.router.deps.logger.error(
          { event: 'route_failed', device_id: this.identity.deviceId, err: error },
          'routing failed',
        );
      });
    const routing = this.#routing === undefined ? run() : this.#routing.then(run);
    this.#routing = routing;
    void routing.then(() => {
      if (this.#routing === routing) this.#routing = undefined;
    });
  }

  async #hello(hello: Hello): Promise<void> {
    this.#helloTimer?.cancel();
    if (hello.client.kind !== this.identity.kind) {
      this.close(CloseCode.policy, 'client kind mismatch');
      return;
    }
    const protocol = negotiateVersion(hello.protocol);
    if (protocol === null) {
      this.error('unsupported_version', null, 'no common protocol version');
      this.close(CloseCode.unsupportedVersion, 'unsupported_version');
      return;
    }
    this.#phase = 'joining';
    let presence: PresenceEntry[];
    let revokedPeers: string[] = [];
    try {
      presence = await this.router.presenceSnapshot(this.identity);
      const revocations = this.router.deps.revocations;
      if (this.identity.kind === 'agent' && revocations !== undefined) {
        revokedPeers = await revocations.revokedPeers(this.identity.deviceId);
      }
    } catch (error) {
      this.router.deps.logger.error(
        { event: 'presence_failed', device_id: this.identity.deviceId, err: error },
        'presence snapshot failed',
      );
      this.close(CloseCode.serviceRestart, 'try again');
      return;
    }
    // The socket may have closed, or the relay started draining, while we waited.
    if (this.#phase !== 'joining') return;
    const result = this.router.deps.hub.attach(this);
    if (!result.ok) {
      this.close(CloseCode.policy, 'device cap');
      return;
    }
    this.#attached = true;
    if (result.superseded !== undefined) {
      result.superseded.close(CloseCode.superseded, 'superseded');
    }
    this.#phase = 'open';
    const now = this.router.deps.clock.now();
    this.send(
      encodeFrame({
        v: VERSION_TABLE.v,
        kind: 'hello_ok',
        protocol,
        min_supported: VERSION_TABLE.min_supported,
        deviceId: this.identity.deviceId,
        relayTs: now,
        presence,
      }),
    );
    // An agent offline at revocation time learns it now and drops the peer key (M1-10).
    for (const deviceId of revokedPeers) {
      this.send(encodeFrame({ v: VERSION_TABLE.v, kind: 'peer_revoked', deviceId }));
    }
    if (result.superseded === undefined) this.router.broadcastPresence(this.identity, true);
    this.#lastMarkedAt = now;
    void this.router.markSeen(this.identity.deviceId, now);
    for (const early of this.#early.splice(0)) {
      if (this.#phase !== 'open') break;
      this.#dispatch(early);
    }
  }

  #scheduleHeartbeat(ms: number): void {
    this.#heartbeat = this.router.deps.timer.after(ms, () => this.#tick());
  }

  /** D15: ping every 25 s; terminate after 35 s without any inbound frame or pong. */
  #tick(): void {
    const now = this.router.deps.clock.now();
    const silentFor = now - this.#lastActivity;
    if (silentFor >= SILENCE_LIMIT_MS) {
      this.router.deps.logger.info(
        { event: 'socket_silent', device_id: this.identity.deviceId },
        'terminating a silent socket',
      );
      this.#phase = 'closed';
      this.#stopTimers();
      this.socket.terminate();
      return;
    }
    this.socket.ping();
    if (this.#attached && now - this.#lastMarkedAt >= LAST_SEEN_INTERVAL_MS) {
      this.#lastMarkedAt = now;
      void this.router.markSeen(this.identity.deviceId, now);
    }
    this.#scheduleHeartbeat(Math.min(PING_INTERVAL_MS, SILENCE_LIMIT_MS - silentFor));
  }

  #stopTimers(): void {
    this.#helloTimer?.cancel();
    this.#heartbeat?.cancel();
  }
}
