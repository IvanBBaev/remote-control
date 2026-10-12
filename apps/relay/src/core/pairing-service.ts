import { sha256, utf8 } from '@remote-control/crypto';
import { toBase64Url, type Clock, type Random } from '@remote-control/protocol';

import type { DeviceIdentity } from '../ports/device-directory.js';
import type {
  BindPhoneResult,
  DeviceRegistry,
  PairingSlotRecord,
} from '../ports/device-registry.js';

const MINUTE = 60_000;

/** A pairing slot accepts a join for 5 minutes and only once (D6, 02 §5.3). */
export const SLOT_TTL_MS = 5 * MINUTE;
/**
 * After a join, the agent has this long to report the handshake (complete or fail): the
 * user compares fingerprints on both screens first, which may run past the slot's TTL.
 */
export const HANDSHAKE_GRACE_MS = 5 * MINUTE;
/** Failed handshakes after which the slot is closed for good (D6). */
export const MAX_FAILED_HANDSHAKES = 3;
/** The one-time string the user pastes into `remotectl login` (02 §5.5, 02 Q2). */
export const ENROLL_TOKEN_PREFIX = 'rc-enroll:';
const AGENT_TOKEN_BYTES = 32;

export type SlotState = 'open' | 'joined' | 'expired' | 'closed';

/** What the agent polls while the phone runs the XXpsk0 handshake (metadata only, I3). */
export interface SlotStatus {
  readonly slotId: string;
  readonly state: SlotState;
  readonly phoneDeviceId: string | null;
  readonly failedAttempts: number;
  readonly expiresAt: number;
}

export type JoinFailure = 'unknown_slot' | 'expired' | 'already_joined' | 'closed';
export type SlotFailure = 'unknown_slot' | 'not_joined' | 'expired' | 'closed';

export interface PairingServiceDeps {
  readonly registry: DeviceRegistry;
  readonly clock: Clock;
  readonly random: Random;
  /** Live devices per user (D25). */
  readonly deviceCap: number;
}

/** The SHA-256 under which an agent bearer token is stored and looked up. */
export function agentTokenHash(token: string): Promise<Uint8Array> {
  return sha256(utf8(token));
}

/**
 * Device enrolment and pairing slots (02 §5.3, §5.5, D6). The relay never sees the
 * pairing code — only a 32-byte hash of it — nor the XXpsk0 frames' plaintext: those
 * travel as ordinary envelopes between the two devices. It records the slot's lifecycle
 * and, when the agent reports a finished handshake, the `phone ↔ agent` pairing (I3).
 */
export class PairingService {
  constructor(private readonly deps: PairingServiceDeps) {}

  /** Binds the login session to a phone device (`sessions.device_id`). */
  bindPhone(
    session: { readonly sessionId: string; readonly userId: string },
    name: string,
    deviceId: string | undefined,
  ): Promise<BindPhoneResult> {
    return this.deps.registry.bindPhone({
      sessionId: session.sessionId,
      userId: session.userId,
      deviceId,
      name,
      cap: this.deps.deviceCap,
      now: this.deps.clock.now(),
    });
  }

  /** Creates an agent device; the token is shown once, only its hash is stored. */
  async enrolAgent(
    userId: string,
    name: string,
  ): Promise<
    | { readonly ok: true; readonly deviceId: string; readonly enrollToken: string }
    | { readonly ok: false; readonly reason: 'device_cap' }
  > {
    const token = this.#newToken();
    const enrolled = await this.deps.registry.enrolAgent({
      userId,
      name,
      tokenHash: await agentTokenHash(token),
      cap: this.deps.deviceCap,
      now: this.deps.clock.now(),
    });
    if (enrolled === null) return { ok: false, reason: 'device_cap' };
    return { ok: true, deviceId: enrolled.deviceId, enrollToken: ENROLL_TOKEN_PREFIX + token };
  }

  /** Replaces the agent's bearer token; the presented one stops working at once. */
  async rotateToken(agent: DeviceIdentity, presented: string): Promise<string | null> {
    const token = this.#newToken();
    const rotated = await this.deps.registry.rotateAgentToken({
      userId: agent.userId,
      agentDeviceId: agent.deviceId,
      oldTokenHash: await agentTokenHash(presented),
      newTokenHash: await agentTokenHash(token),
      now: this.deps.clock.now(),
    });
    return rotated ? token : null;
  }

  /** Opens the agent's single slot (replacing any earlier one) for `SLOT_TTL_MS`. */
  async openSlot(
    agent: DeviceIdentity,
    codeHash: Uint8Array,
  ): Promise<
    | { readonly ok: true; readonly slotId: string; readonly expiresAt: number }
    | { readonly ok: false; readonly reason: 'code_in_use' }
  > {
    const now = this.deps.clock.now();
    const slot = await this.deps.registry.openSlot({
      userId: agent.userId,
      agentDeviceId: agent.deviceId,
      codeHash,
      expiresAt: now + SLOT_TTL_MS,
      now,
    });
    if (slot === null) return { ok: false, reason: 'code_in_use' };
    return { ok: true, slotId: slot.id, expiresAt: slot.expiresAt };
  }

  /** The phone claims the slot its code names; a slot is joined at most once. */
  async joinSlot(
    phone: DeviceIdentity,
    codeHash: Uint8Array,
  ): Promise<
    | {
        readonly ok: true;
        readonly slotId: string;
        readonly agentDeviceId: string;
        readonly expiresAt: number;
      }
    | { readonly ok: false; readonly reason: JoinFailure }
  > {
    const now = this.deps.clock.now();
    const joined = await this.deps.registry.joinSlot({
      userId: phone.userId,
      phoneDeviceId: phone.deviceId,
      codeHash,
      maxFailures: MAX_FAILED_HANDSHAKES,
      now,
    });
    if (joined.ok) {
      return {
        ok: true,
        slotId: joined.slot.id,
        agentDeviceId: joined.slot.agentDeviceId,
        expiresAt: joined.slot.expiresAt,
      };
    }
    const { slot } = joined;
    if (slot === undefined) return { ok: false, reason: 'unknown_slot' };
    if (slot.failedAttempts >= MAX_FAILED_HANDSHAKES) return { ok: false, reason: 'closed' };
    if (slot.joinedAt === null && now >= slot.expiresAt) return { ok: false, reason: 'expired' };
    return { ok: false, reason: 'already_joined' };
  }

  async status(agent: DeviceIdentity, slotId: string): Promise<SlotStatus | undefined> {
    const slot = await this.deps.registry.findSlot(slotId, agent.deviceId);
    return slot && this.#status(slot);
  }

  /** The agent finished the XXpsk0 handshake (fingerprints confirmed): record the pairing. */
  async complete(
    agent: DeviceIdentity,
    slotId: string,
  ): Promise<
    | { readonly ok: true; readonly pairingId: string; readonly phoneDeviceId: string }
    | { readonly ok: false; readonly reason: SlotFailure }
  > {
    const found = await this.#joined(agent, slotId);
    if (!found.ok) return found;
    const { slot, phoneDeviceId } = found;
    const completed = await this.deps.registry.completeSlot({
      slot,
      phoneDeviceId,
      now: this.deps.clock.now(),
    });
    if (completed === null) return { ok: false, reason: 'not_joined' };
    return { ok: true, pairingId: completed.pairingId, phoneDeviceId };
  }

  /** The handshake with the joined phone failed: reopen the slot, or close it at the limit. */
  async fail(
    agent: DeviceIdentity,
    slotId: string,
  ): Promise<
    | { readonly ok: true; readonly state: 'open' | 'closed'; readonly failedAttempts: number }
    | { readonly ok: false; readonly reason: SlotFailure }
  > {
    const found = await this.#joined(agent, slotId);
    if (!found.ok) return found;
    const failures = await this.deps.registry.failSlot(found.slot.id, found.phoneDeviceId);
    if (failures === null) return { ok: false, reason: 'not_joined' };
    return {
      ok: true,
      state: failures >= MAX_FAILED_HANDSHAKES ? 'closed' : 'open',
      failedAttempts: failures,
    };
  }

  /** The agent abandons its slot (`remotectl pair` cancelled). */
  async cancel(agent: DeviceIdentity, slotId: string): Promise<boolean> {
    const slot = await this.deps.registry.findSlot(slotId, agent.deviceId);
    if (slot === undefined) return false;
    await this.deps.registry.deleteSlot(slot.id);
    return true;
  }

  async #joined(
    agent: DeviceIdentity,
    slotId: string,
  ): Promise<
    | { readonly ok: true; readonly slot: PairingSlotRecord; readonly phoneDeviceId: string }
    | { readonly ok: false; readonly reason: SlotFailure }
  > {
    const slot = await this.deps.registry.findSlot(slotId, agent.deviceId);
    if (slot === undefined) return { ok: false, reason: 'unknown_slot' };
    const { state } = this.#status(slot);
    if (state === 'expired' || state === 'closed') return { ok: false, reason: state };
    if (state === 'open' || slot.phoneDeviceId === null) return { ok: false, reason: 'not_joined' };
    return { ok: true, slot, phoneDeviceId: slot.phoneDeviceId };
  }

  #status(slot: PairingSlotRecord): SlotStatus {
    const now = this.deps.clock.now();
    let state: SlotState;
    if (slot.failedAttempts >= MAX_FAILED_HANDSHAKES) state = 'closed';
    else if (slot.joinedAt !== null) {
      state = now < slot.joinedAt + HANDSHAKE_GRACE_MS ? 'joined' : 'expired';
    } else state = now < slot.expiresAt ? 'open' : 'expired';
    return {
      slotId: slot.id,
      state,
      phoneDeviceId: slot.phoneDeviceId,
      failedAttempts: slot.failedAttempts,
      expiresAt: slot.expiresAt,
    };
  }

  #newToken(): string {
    return toBase64Url(this.deps.random.bytes(AGENT_TOKEN_BYTES));
  }
}
