import type { DeviceKind } from './device-directory.js';

/**
 * Revocation and account deletion (M1-10, 02 §5.9). A revoked device keeps its row
 * (with `revoked_at`) so `/api/state` can report it; account deletion removes every row
 * that names the user or one of the user's devices.
 */
export interface DeviceRevocations {
  /**
   * Revokes a live device of the user in one transaction: stamps `devices.revoked_at`
   * and the `revoked_at` of every pairing it is part of, deletes its login sessions,
   * push subscriptions, agent tokens and pairing slots, and audits `device_revoked`.
   * Returns the device's kind, or `null` when it is unknown, foreign or already revoked.
   */
  revokeDevice(input: {
    readonly userId: string;
    readonly deviceId: string;
    /** The kinds the caller may revoke; another kind counts as unknown. */
    readonly kinds: readonly DeviceKind[];
    readonly now: number;
  }): Promise<DeviceKind | null>;
  /** The phones whose pairing with this agent is revoked (replayed to the agent on connect). */
  revokedPeers(agentDeviceId: string): Promise<string[]>;
  /**
   * Deletes the account: its audit rows (by user and by device), the invite codes it
   * redeemed and the user row, which cascades to every other table. `false` if unknown.
   */
  deleteAccount(userId: string): Promise<boolean>;
}
