import type { DeviceIdentity } from './device-directory.js';

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

/**
 * Who is connected (D15, 03 §5.2): `userId → deviceId → connection`, one connection
 * per device. `LocalHub` is the in-memory implementation; a `PgNotifyHub` is the
 * post-MVP path to two replicas (03 §5.14). Lookups are always scoped by `userId`, so
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
  /** When the device last came online or went offline (relay clock), if known. */
  presenceChangedAt(deviceId: string): number | undefined;
  /** Forgets every connection and closes it with `code` (shutdown). */
  closeAll(code: number, reason: string): readonly HubConnection[];
}
