/** Times are Unix epoch milliseconds from the Clock port. */

export type DeviceKind = 'phone' | 'agent';

/** Who is on the other end of a socket, fixed before the upgrade (D15, 03 §5.1). */
export interface DeviceIdentity {
  readonly userId: string;
  readonly deviceId: string;
  readonly kind: DeviceKind;
}

/** A device row as presence and `/api/state` need it (metadata only, I3). */
export interface DeviceRecord {
  readonly id: string;
  readonly kind: DeviceKind;
  readonly name: string;
  readonly createdAt: number;
  readonly lastSeenAt: number | null;
  readonly revokedAt: number | null;
}

/**
 * The relay's view of `devices`, `agent_tokens` and the session ↔ phone link. Every
 * lookup that crosses users is keyed by a hash or scoped by `userId`.
 */
export interface DeviceDirectory {
  /**
   * The live agent behind a bearer token hash (token and device not revoked); stamps
   * `agent_tokens.last_used_at`. `undefined` = unknown or revoked.
   */
  authenticateAgent(tokenHash: Uint8Array, now: number): Promise<DeviceIdentity | undefined>;
  /** The live phone device bound to a login session of this user, if any. */
  phoneForSession(sessionId: string, userId: string): Promise<DeviceIdentity | undefined>;
  /** Every device of the user, revoked ones included (`/api/state?since=` reports revocations). */
  listDevices(userId: string): Promise<DeviceRecord[]>;
  /** The owner of a live (not revoked) device, or `undefined`. */
  ownerOf(deviceId: string): Promise<string | undefined>;
  /** Writes `devices.last_seen_at` (callers throttle it, 03 §5.2). */
  markSeen(deviceId: string, now: number): Promise<void>;
}
