/** Times are Unix epoch milliseconds from the Clock port; the adapter maps them to `timestamptz`. */

/** A pairing slot as the agent that opened it sees it (metadata only, I3). */
export interface PairingSlotRecord {
  readonly id: string;
  readonly userId: string;
  readonly agentDeviceId: string;
  readonly expiresAt: number;
  readonly joinedAt: number | null;
  readonly phoneDeviceId: string | null;
  readonly failedAttempts: number;
}

export type BindPhoneResult =
  | { readonly ok: true; readonly deviceId: string; readonly created: boolean }
  | { readonly ok: false; readonly reason: 'unknown_device' | 'device_cap' };

export type JoinSlotResult =
  | { readonly ok: true; readonly slot: PairingSlotRecord }
  | { readonly ok: false; readonly slot: PairingSlotRecord | undefined };

/**
 * Enrolment of phones and agents, agent bearer tokens and pairing slots (02 §5.3, §5.5,
 * D6, D25). Every value that could authenticate (agent token, pairing code) arrives as
 * a hash; every lookup is scoped by `userId`. Multi-row changes are one transaction that
 * writes its `audit_log` row (event, user, device, time — no bodies, D19).
 */
export interface DeviceRegistry {
  /**
   * Binds a login session to a phone device (`sessions.device_id`): keeps the session's
   * live phone, re-binds to `deviceId` (a live phone of the same user), or creates a phone
   * while the user has fewer than `cap` live devices.
   */
  bindPhone(input: {
    readonly sessionId: string;
    readonly userId: string;
    readonly deviceId: string | undefined;
    readonly name: string;
    readonly cap: number;
    readonly now: number;
  }): Promise<BindPhoneResult>;
  /** Creates an agent device with its first token; `null` when the user has `cap` live devices. */
  enrolAgent(input: {
    readonly userId: string;
    readonly name: string;
    readonly tokenHash: Uint8Array;
    readonly cap: number;
    readonly now: number;
  }): Promise<{ readonly deviceId: string } | null>;
  /** Revokes the live token `oldTokenHash` of the agent and stores `newTokenHash`; `false` if it was not live. */
  rotateAgentToken(input: {
    readonly userId: string;
    readonly agentDeviceId: string;
    readonly oldTokenHash: Uint8Array;
    readonly newTokenHash: Uint8Array;
    readonly now: number;
  }): Promise<boolean>;
  /**
   * Opens a slot for the agent: deletes every other slot of that agent and every expired
   * slot, then inserts this one. `null` when a live slot already holds `codeHash`.
   */
  openSlot(input: {
    readonly userId: string;
    readonly agentDeviceId: string;
    readonly codeHash: Uint8Array;
    readonly expiresAt: number;
    readonly now: number;
  }): Promise<PairingSlotRecord | null>;
  /**
   * Atomically joins the user's open slot with this code hash (unexpired, not joined,
   * fewer than `maxFailures` failed handshakes, agent live). On refusal, returns the slot
   * the hash names (if any) so the caller can tell why.
   */
  joinSlot(input: {
    readonly userId: string;
    readonly phoneDeviceId: string;
    readonly codeHash: Uint8Array;
    readonly maxFailures: number;
    readonly now: number;
  }): Promise<JoinSlotResult>;
  /** The slot if it belongs to this agent. */
  findSlot(slotId: string, agentDeviceId: string): Promise<PairingSlotRecord | undefined>;
  /**
   * Records the `phone ↔ agent` pairing of a joined slot (re-activating a revoked edge)
   * and deletes the slot; `null` if the slot is no longer joined by `phoneDeviceId` or the phone is gone.
   */
  completeSlot(input: {
    readonly slot: PairingSlotRecord;
    readonly phoneDeviceId: string;
    readonly now: number;
  }): Promise<{ readonly pairingId: string } | null>;
  /** Clears the join of a slot after a failed handshake; returns the new failure count. */
  failSlot(slotId: string, phoneDeviceId: string): Promise<number | null>;
  deleteSlot(slotId: string): Promise<void>;
}
