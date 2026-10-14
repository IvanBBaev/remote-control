import type { DeviceIdentity, DeviceKind } from './device-directory.js';

/** One live, authenticated device socket as the hub sees it. */
export interface HubConnection {
  readonly identity: DeviceIdentity;
  /** Sends one encoded frame; `false` when it was dropped (backpressure or closed socket). */
  send(text: string): boolean;
  close(code: number, reason: string): void;
}

export type AttachResult =
  | { readonly ok: true; readonly superseded: HubConnection | undefined }
  | { readonly ok: false; readonly reason: 'device_cap' };

/** What a replica's router does for events that originate on another replica. */
export interface ClusterHandlers {
  /** A recipient on another replica acked `ids`; settle the ones this replica forwarded. */
  ack(userId: string, recipientId: string, ids: readonly string[]): void;
  /** `device`'s replica died; tell its user's `localPeers` it is offline. */
  lost(device: DeviceIdentity, localPeers: readonly HubConnection[]): void;
}

/** The cross-replica side of a hub (ADR 0012); absent on a single replica. */
export interface HubCluster {
  /** Registers the router's handlers (once). */
  bind(handlers: ClusterHandlers): void;
  /** Tells the other replicas that `recipientId` acked `ids`. */
  publishAck(userId: string, recipientId: string, ids: readonly string[]): void;
}

/**
 * Who is connected (D15, 03 §5.2): `userId → deviceId → connection`, one connection
 * per device. `LocalHub` is the in-memory implementation; `PgNotifyHub` spans replicas
 * over Postgres `LISTEN`/`NOTIFY` (03 §5.14, ADR 0012), where a device on another replica
 * is a proxy connection whose `send` returns `true` once the frame is queued. Lookups are always scoped by `userId`, so
 * a connection of one user can never be found through another.
 */
export interface HubPort {
  /** Registers `connection`; an existing one for the same device is returned as `superseded`. */
  attach(connection: HubConnection): AttachResult;
  /** Removes `connection` if it is still the current one for its device; `true` if removed. */
  detach(connection: HubConnection): boolean;
  connection(userId: string, deviceId: string): HubConnection | undefined;
  connections(userId: string): readonly HubConnection[];
  /** Live devices of the user. */
  count(userId: string): number;
  /** Live devices of `kind` across all users (admin counters, M1-13). */
  online(kind: DeviceKind): number;
  /** When the device last came online or went offline (relay clock), if known. */
  presenceChangedAt(deviceId: string): number | undefined;
  /** Forgets every connection and closes it with `code` (shutdown). */
  closeAll(code: number, reason: string): readonly HubConnection[];
  /** Present when devices of one user may be connected to different replicas. */
  readonly cluster?: HubCluster;
}
