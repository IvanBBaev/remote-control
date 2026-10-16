import { toHex, type Clock, type Random } from '@remote-control/protocol';
import type { Logger } from 'pino';
import { z } from 'zod';

import type { DeviceIdentity, DeviceKind } from '../ports/device-directory.js';
import type {
  AttachResult,
  ClusterHandlers,
  HubCluster,
  HubConnection,
  HubPort,
} from '../ports/hub.js';
import type { Notification, NotifyBus } from '../ports/notify-bus.js';
import type { Timer, TimerHandle } from '../ports/timer.js';
import { LocalHub, MAX_PRESENCE_ENTRIES } from './local-hub.js';

/** The channel every replica listens on; each also listens on `<base>_<replica id>`. */
export const HUB_CHANNEL = 'rc_hub';
/** How often a replica announces itself. */
export const HUB_HEARTBEAT_MS = 5_000;
/** A replica silent this long is gone: its devices are dropped and reported offline. */
export const HUB_REPLICA_TIMEOUT_MS = 15_000;
/** Largest notification payload sent; Postgres refuses 8000 bytes and more (03 F24). */
export const MAX_NOTIFY_BYTES = 7_900;
/** Base64 characters per chunk of a frame that does not fit one notification. */
const CHUNK_CHARS = 7_000;
/** Ack ids per notification (ids are UUIDs, ~40 bytes each as JSON). */
const ACK_IDS_PER_MESSAGE = 128;
/** Partly received frames kept at once; the oldest is dropped beyond this. */
const MAX_PARTIAL_FRAMES = 64;

const displacedKey = (userId: string, deviceId: string) => `${userId}:${deviceId}`;

const identityFields = { u: z.string(), d: z.string() };
const Message = z.discriminatedUnion('t', [
  /**
   * A replica started or re-listened: the others drop what they knew of its devices (its
   * `on`s follow in the same transaction) and reply with their own.
   */
  z.object({ t: z.literal('hello'), r: z.string() }),
  z.object({ t: z.literal('hb'), r: z.string() }),
  /** The replica is shutting down; its devices reconnect elsewhere. */
  z.object({ t: z.literal('bye'), r: z.string() }),
  /** `a`: when the socket attached (relay clock); the later attach of a device wins. */
  z.object({
    t: z.literal('on'),
    r: z.string(),
    ...identityFields,
    k: z.enum(['phone', 'agent']),
    a: z.number().optional(),
  }),
  z.object({ t: z.literal('off'), r: z.string(), ...identityFields }),
  /** A frame for a device of the receiving replica: whole (`x`) or one chunk of it. */
  z.object({
    t: z.literal('tx'),
    r: z.string(),
    ...identityFields,
    x: z.string(),
    c: z.number().int().optional(),
    i: z.number().int().optional(),
    n: z.number().int().optional(),
  }),
  z.object({
    t: z.literal('close'),
    r: z.string(),
    ...identityFields,
    code: z.number().int(),
    why: z.string(),
  }),
  z.object({ t: z.literal('ack'), r: z.string(), ...identityFields, ids: z.array(z.string()) }),
]);
type Message = z.infer<typeof Message>;

interface RemoteDevice {
  readonly replica: string;
  readonly connection: HubConnection;
  readonly attachedAt: number | undefined;
}

/**
 * Whether an attach on `replica` at `at` came after one on `other` at `otherAt`; equal
 * times fall to the larger replica id, so every replica picks the same winner.
 */
const newer = (at: number, replica: string, otherAt: number, other: string) =>
  at > otherAt || (at === otherAt && replica > other);

interface PartialFrame {
  readonly parts: string[];
  received: number;
}

export interface PgNotifyHubDeps {
  readonly clock: Clock;
  readonly timer: Timer;
  readonly random: Random;
  readonly bus: NotifyBus;
  readonly logger: Logger;
  readonly deviceCap: number;
}

/**
 * The hub across relay replicas (D15, 03 §5.14, ADR 0012). Local sockets live in a
 * {@link LocalHub}; every attach and detach is announced over Postgres `NOTIFY`, so each
 * replica knows which replica holds each device. A device on another replica is a proxy
 * connection: `send` and `close` become a `NOTIFY` on the owning replica's channel.
 * Frames pass through Postgres' transient notification queue only — never a table (D4).
 * Heartbeats expire a replica that died without saying goodbye.
 */
export class PgNotifyHub implements HubPort, HubCluster {
  readonly replicaId: string;
  readonly cluster: HubCluster = this;
  readonly #local: LocalHub;
  /** userId → deviceId → the device on another replica. */
  readonly #remote = new Map<string, Map<string, RemoteDevice>>();
  /** Other replicas → when they were last heard from (relay clock). */
  readonly #replicas = new Map<string, number>();
  readonly #changedAt = new Map<string, number>();
  readonly #partial = new Map<string, PartialFrame>();
  /**
   * Local sockets of devices that moved to another replica, until that replica's
   * `close` (the supersede) reaches them or they detach on their own.
   */
  readonly #displaced = new Map<string, HubConnection>();
  /** When each local socket attached, for the `on` that announces it. */
  readonly #attachedAt = new WeakMap<HubConnection, number>();
  #handlers: ClusterHandlers | undefined;
  #heartbeat: TimerHandle | undefined;
  #chunkSeq = 0;
  #stopped = false;
  /** A notification was lost: the next heartbeat announces this replica's devices again. */
  #announceDue = false;

  constructor(private readonly deps: PgNotifyHubDeps) {
    this.replicaId = toHex(deps.random.bytes(8));
    // The cap spans replicas, so this hub checks it; the local part never refuses.
    this.#local = new LocalHub(deps.clock, Number.POSITIVE_INFINITY);
  }

  /** Listens, asks the other replicas for their devices and starts the heartbeat. */
  async start(): Promise<void> {
    this.deps.bus.onReconnect(() => this.#resync());
    await this.deps.bus.listen(
      [HUB_CHANNEL, this.#channelOf(this.replicaId)],
      (_channel, payload) => this.#receive(payload),
    );
    this.#announce();
    this.#scheduleHeartbeat();
  }

  /** Says goodbye (the other replicas drop this one's devices at once) and stops listening. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#heartbeat?.cancel();
    try {
      await this.deps.bus.publish([this.#broadcast({ t: 'bye', r: this.replicaId })]);
    } catch (error) {
      this.#publishFailed(error);
    }
    await this.deps.bus.close();
  }

  // ── HubPort ──────────────────────────────────────────────────────────────────────

  attach(connection: HubConnection): AttachResult {
    const { userId, deviceId } = connection.identity;
    const remote = this.#remote.get(userId)?.get(deviceId);
    const local = this.#local.connection(userId, deviceId);
    if (local === undefined && remote === undefined && this.count(userId) >= this.deps.deviceCap) {
      return { ok: false, reason: 'device_cap' };
    }
    this.#local.attach(connection);
    // After the attach it supersedes, even on a replica whose clock is behind.
    const after = remote?.attachedAt === undefined ? 0 : remote.attachedAt + 1;
    this.#attachedAt.set(connection, Math.max(this.deps.clock.now(), after));
    if (remote !== undefined) this.#forgetRemote(userId, deviceId);
    this.#publish([this.#broadcast(this.#on(connection))]);
    return { ok: true, superseded: local ?? remote?.connection };
  }

  detach(connection: HubConnection): boolean {
    const { userId, deviceId } = connection.identity;
    const key = displacedKey(userId, deviceId);
    if (this.#displaced.get(key) === connection) this.#displaced.delete(key);
    if (!this.#local.detach(connection)) return false;
    this.#publish([this.#broadcast({ t: 'off', r: this.replicaId, u: userId, d: deviceId })]);
    return true;
  }

  connection(userId: string, deviceId: string): HubConnection | undefined {
    return (
      this.#local.connection(userId, deviceId) ??
      this.#remote.get(userId)?.get(deviceId)?.connection
    );
  }

  connections(userId: string): readonly HubConnection[] {
    const remote = [...(this.#remote.get(userId)?.values() ?? [])].map(
      (device) => device.connection,
    );
    return [...this.#local.connections(userId), ...remote];
  }

  count(userId: string): number {
    return this.#local.count(userId) + (this.#remote.get(userId)?.size ?? 0);
  }

  online(kind: DeviceKind): number {
    let total = this.#local.online(kind);
    for (const devices of this.#remote.values()) {
      for (const device of devices.values())
        if (device.connection.identity.kind === kind) total += 1;
    }
    return total;
  }

  presenceChangedAt(deviceId: string): number | undefined {
    const local = this.#local.presenceChangedAt(deviceId);
    const remote = this.#changedAt.get(deviceId);
    if (local === undefined) return remote;
    return remote === undefined ? local : Math.max(local, remote);
  }

  closeAll(code: number, reason: string): readonly HubConnection[] {
    return this.#local.closeAll(code, reason);
  }

  // ── HubCluster ───────────────────────────────────────────────────────────────────

  bind(handlers: ClusterHandlers): void {
    this.#handlers = handlers;
  }

  publishAck(userId: string, recipientId: string, ids: readonly string[]): void {
    const messages: Notification[] = [];
    for (let at = 0; at < ids.length; at += ACK_IDS_PER_MESSAGE) {
      messages.push(
        this.#broadcast({
          t: 'ack',
          r: this.replicaId,
          u: userId,
          d: recipientId,
          ids: ids.slice(at, at + ACK_IDS_PER_MESSAGE),
        }),
      );
    }
    this.#publish(messages);
  }

  /** Other replicas this one has heard from (tests, diagnostics). */
  get peers(): readonly string[] {
    return [...this.#replicas.keys()];
  }

  // ── inbound ──────────────────────────────────────────────────────────────────────

  #receive(payload: string): void {
    let message: Message;
    try {
      message = Message.parse(JSON.parse(payload));
    } catch {
      this.deps.logger.warn({ event: 'hub_message_invalid' }, 'malformed hub notification');
      return;
    }
    if (message.r === this.replicaId || this.#stopped) return;
    if (message.t === 'bye') {
      this.#replicas.delete(message.r);
      this.#dropReplica(message.r, false);
      return;
    }
    const known = this.#replicas.has(message.r);
    this.#replicas.set(message.r, this.deps.clock.now());
    // Heard again after it was taken for gone: each side dropped the other's devices.
    if (!known && message.t !== 'hello') this.#announce(message.r);
    switch (message.t) {
      case 'hello':
        this.#dropReplica(message.r, false);
        this.#announceTo(message.r);
        return;
      case 'hb':
        return;
      case 'on':
        this.#remoteAttached(
          message.r,
          { userId: message.u, deviceId: message.d, kind: message.k },
          message.a,
        );
        return;
      case 'off':
        if (this.#remote.get(message.u)?.get(message.d)?.replica === message.r) {
          this.#forgetRemote(message.u, message.d);
        }
        return;
      case 'tx':
        this.#frame(message);
        return;
      case 'close': {
        // A displaced socket first: the close is the supersede aimed at it.
        const key = displacedKey(message.u, message.d);
        const target = this.#displaced.get(key) ?? this.#local.connection(message.u, message.d);
        this.#displaced.delete(key);
        target?.close(message.code, message.why);
        return;
      }
      case 'ack':
        this.#handlers?.ack(message.u, message.d, message.ids);
        return;
    }
  }

  #remoteAttached(replica: string, identity: DeviceIdentity, at: number | undefined): void {
    const { userId, deviceId } = identity;
    const local = this.#local.connection(userId, deviceId);
    const localAt = local === undefined ? undefined : this.#attachedAt.get(local);
    // A claim older than the socket here (sent before a missed notification, or raced
    // with this attach) is stale: keep the socket and tell that replica it lost.
    if (local !== undefined && at !== undefined && localAt !== undefined) {
      if (newer(localAt, this.replicaId, at, replica)) {
        this.#publish([this.#direct(replica, this.#on(local))]);
        return;
      }
    }
    const current = this.#remote.get(userId)?.get(deviceId);
    if (
      current !== undefined &&
      current.replica !== replica &&
      at !== undefined &&
      current.attachedAt !== undefined &&
      newer(current.attachedAt, current.replica, at, replica)
    ) {
      return;
    }
    // The device moved here from this replica: forget the local socket now, so its
    // close (the `superseded` notification that follows) does not report it offline.
    if (local !== undefined) {
      this.#local.detach(local);
      this.#displaced.set(displacedKey(userId, deviceId), local);
    }
    let devices = this.#remote.get(userId);
    if (devices === undefined) {
      devices = new Map();
      this.#remote.set(userId, devices);
    }
    devices.set(deviceId, {
      replica,
      connection: this.#proxy(replica, identity),
      attachedAt: at,
    });
    this.#touch(deviceId);
  }

  #frame(message: Extract<Message, { t: 'tx' }>): void {
    let text = message.x;
    if (message.c !== undefined) {
      const key = `${message.r}:${String(message.c)}`;
      const total = message.n ?? 0;
      let partial = this.#partial.get(key);
      if (partial === undefined) {
        if (this.#partial.size >= MAX_PARTIAL_FRAMES) {
          this.#partial.delete(this.#partial.keys().next().value as string);
        }
        partial = { parts: new Array<string>(total), received: 0 };
        this.#partial.set(key, partial);
      }
      const index = message.i ?? 0;
      if (partial.parts[index] === undefined) partial.received += 1;
      partial.parts[index] = message.x;
      if (partial.received < total) return;
      this.#partial.delete(key);
      text = Buffer.from(partial.parts.join(''), 'base64').toString('utf8');
    }
    // A device that left meanwhile misses the frame; its sender re-sends unacked ones (D4).
    this.#local.connection(message.u, message.d)?.send(text);
  }

  // ── outbound ─────────────────────────────────────────────────────────────────────

  #proxy(replica: string, identity: DeviceIdentity): HubConnection {
    const target = { u: identity.userId, d: identity.deviceId };
    return {
      identity,
      send: (text) => {
        if (this.#stopped) return false;
        this.#publish(this.#frameNotifications(replica, target, text));
        return true;
      },
      close: (code, reason) => {
        this.#publish([
          this.#direct(replica, { t: 'close', r: this.replicaId, ...target, code, why: reason }),
        ]);
      },
    };
  }

  #frameNotifications(
    replica: string,
    target: { readonly u: string; readonly d: string },
    text: string,
  ): Notification[] {
    const whole = this.#direct(replica, { t: 'tx', r: this.replicaId, ...target, x: text });
    if (Buffer.byteLength(whole.payload) <= MAX_NOTIFY_BYTES) return [whole];
    const encoded = Buffer.from(text, 'utf8').toString('base64');
    const total = Math.ceil(encoded.length / CHUNK_CHARS);
    const c = (this.#chunkSeq += 1);
    const chunks: Notification[] = [];
    for (let i = 0; i < total; i += 1) {
      const x = encoded.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS);
      chunks.push(
        this.#direct(replica, { t: 'tx', r: this.replicaId, ...target, x, c, i, n: total }),
      );
    }
    return chunks;
  }

  /** Answers a `hello`: this replica's devices, on the asking replica's channel. */
  #announceTo(replica: string): void {
    const messages = this.#local
      .all()
      .map((connection) => this.#direct(replica, this.#on(connection)));
    if (messages.length > 0) this.#publish(messages);
  }

  /**
   * A `hello` and this replica's devices, to every replica or to one: the receivers
   * replace what they knew of them, and reply with their own.
   */
  #announce(replica?: string): void {
    const to = (message: Message) =>
      replica === undefined ? this.#broadcast(message) : this.#direct(replica, message);
    this.#publish([
      to({ t: 'hello', r: this.replicaId }),
      ...this.#local.all().map((connection) => to(this.#on(connection))),
    ]);
  }

  /**
   * After the listening connection came back: notifications were missed, so the remote
   * devices known here may be gone. Forget them; the replies to the `hello` re-add the
   * ones still connected.
   */
  #resync(): void {
    if (this.#stopped) return;
    this.#partial.clear();
    for (const [userId, devices] of [...this.#remote]) {
      for (const deviceId of [...devices.keys()]) this.#forgetRemote(userId, deviceId);
    }
    this.#announce();
  }

  #on(connection: HubConnection): Message {
    const { userId, deviceId, kind } = connection.identity;
    const at = this.#attachedAt.get(connection);
    return {
      t: 'on',
      r: this.replicaId,
      u: userId,
      d: deviceId,
      k: kind,
      ...(at === undefined ? {} : { a: at }),
    };
  }

  #scheduleHeartbeat(): void {
    this.#heartbeat = this.deps.timer.after(HUB_HEARTBEAT_MS, () => {
      if (this.#stopped) return;
      if (this.#announceDue) {
        this.#announceDue = false;
        this.#announce();
      } else {
        this.#publish([this.#broadcast({ t: 'hb', r: this.replicaId })]);
      }
      const now = this.deps.clock.now();
      for (const [replica, heardAt] of this.#replicas) {
        if (now - heardAt < HUB_REPLICA_TIMEOUT_MS) continue;
        this.deps.logger.warn({ event: 'hub_replica_lost', replica }, 'relay replica went silent');
        this.#replicas.delete(replica);
        this.#dropReplica(replica, true);
      }
      this.#scheduleHeartbeat();
    });
  }

  #dropReplica(replica: string, reportOffline: boolean): void {
    for (const [userId, devices] of [...this.#remote]) {
      for (const [deviceId, device] of [...devices]) {
        if (device.replica !== replica) continue;
        this.#forgetRemote(userId, deviceId);
        if (reportOffline) {
          this.#handlers?.lost(device.connection.identity, this.#local.connections(userId));
        }
      }
    }
  }

  #forgetRemote(userId: string, deviceId: string): void {
    const devices = this.#remote.get(userId);
    if (devices?.delete(deviceId) !== true) return;
    if (devices.size === 0) this.#remote.delete(userId);
    this.#touch(deviceId);
  }

  #channelOf(replica: string): string {
    return `${HUB_CHANNEL}_${replica}`;
  }

  #broadcast(message: Message): Notification {
    return { channel: HUB_CHANNEL, payload: JSON.stringify(message) };
  }

  #direct(replica: string, message: Message): Notification {
    return { channel: this.#channelOf(replica), payload: JSON.stringify(message) };
  }

  #publish(notifications: readonly Notification[]): void {
    if (this.#stopped) return;
    this.deps.bus.publish(notifications).catch((error: unknown) => this.#publishFailed(error));
  }

  #publishFailed(error: unknown): void {
    // An `on` or `off` may be among the lost ones; `stop` has nothing left to fix.
    if (!this.#stopped) this.#announceDue = true;
    this.deps.logger.warn(
      { event: 'hub_publish_failed', code: (error as { code?: string }).code ?? 'unknown' },
      'hub notification not sent',
    );
  }

  #touch(deviceId: string): void {
    this.#changedAt.delete(deviceId);
    this.#changedAt.set(deviceId, this.deps.clock.now());
    if (this.#changedAt.size > MAX_PRESENCE_ENTRIES) {
      this.#changedAt.delete(this.#changedAt.keys().next().value as string);
    }
  }
}
