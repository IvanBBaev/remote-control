/** A relay HTTP call: the parsed body, or the status and `error` code it was refused with. */
export type RelayResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      /** HTTP status; 0 when the request never got an answer (offline, timeout). */
      readonly status: number;
      /** The relay's `error` code, or `network` / `bad_response`. */
      readonly error: string;
    };

export type SlotState = 'open' | 'joined' | 'expired' | 'closed';

export interface OpenedSlot {
  readonly slotId: string;
  readonly expiresAt: number;
}

export interface SlotStatus {
  readonly slotId: string;
  readonly state: SlotState;
  readonly phoneDeviceId: string | null;
  readonly failedAttempts: number;
  readonly expiresAt: number;
}

export interface RotatedToken {
  readonly token: string;
  /** Lower-case account UUID, used in the D3/D6 prologues. */
  readonly userId: string;
}

export interface CompletedSlot {
  readonly pairingId: string;
  readonly phoneDeviceId: string;
}

export interface FailedSlot {
  readonly state: 'open' | 'closed';
  readonly failedAttempts: number;
}

/** The relay's agent-side HTTP API (M0-10): token rotation and pairing slots (D6). */
export interface RelayApi {
  /**
   * `POST /api/agents/token`: a new bearer token (the presented one stops working) and
   * the account id the agent belongs to.
   */
  rotateToken(): Promise<RelayResult<RotatedToken>>;
  /** `POST /api/pairings`: opens a slot matched by `codeHash`; 409 `code_in_use`. */
  openSlot(codeHash: string): Promise<RelayResult<OpenedSlot>>;
  slotStatus(slotId: string): Promise<RelayResult<SlotStatus>>;
  completeSlot(slotId: string): Promise<RelayResult<CompletedSlot>>;
  /** Counts a failed handshake; the slot closes at the third. */
  failSlot(slotId: string): Promise<RelayResult<FailedSlot>>;
  cancelSlot(slotId: string): Promise<RelayResult<null>>;
}
