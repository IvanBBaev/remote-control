import type { Timer, TimerHandle } from '../ports/timer.js';

/** D4: a `cls: request` frame a phone has not acked within 3 s triggers Web Push (M0-12). */
export const UNACKED_REQUEST_MS = 3_000;
/** How long the relay remembers a forwarded envelope so the recipient's `ack` reaches its sender. */
export const ACK_WINDOW_MS = 60_000;
/** Remembered envelopes per recipient; the oldest is forgotten first. */
export const MAX_TRACKED_PER_RECIPIENT = 1_024;

/** One forwarded envelope awaiting the recipient's `ack`. Header fields only (I3). */
export interface TrackedDelivery {
  readonly envelopeId: string;
  readonly userId: string;
  /** Sender device; the forwarded `ack` goes back to it. */
  readonly from: string;
  /** Recipient device; only its `ack` counts. */
  readonly to: string;
  /** Run `onUnacked` if no `ack` arrives within {@link UNACKED_REQUEST_MS}. */
  readonly watch: boolean;
  readonly expiresAt: number | null;
}

/** Called when a watched delivery stays unacked (the M0-12 push trigger). */
export type UnackedListener = (delivery: TrackedDelivery) => void;

interface Entry {
  readonly delivery: TrackedDelivery;
  handle: TimerHandle;
}

/**
 * In-memory ack bookkeeping (D4: no outbox, ack timers in memory). The relay forwards
 * a recipient's `ack` to the envelope's sender (who keeps unacked frames and re-sends
 * them) and reports watched deliveries that stay unacked.
 */
export class AckTracker {
  /** recipient → envelope id → entry, in insertion order. */
  readonly #byRecipient = new Map<string, Map<string, Entry>>();

  constructor(
    private readonly timer: Timer,
    private readonly onUnacked: UnackedListener,
  ) {}

  track(delivery: TrackedDelivery): void {
    let entries = this.#byRecipient.get(delivery.to);
    if (entries === undefined) {
      entries = new Map();
      this.#byRecipient.set(delivery.to, entries);
    }
    const previous = entries.get(delivery.envelopeId);
    if (previous !== undefined) {
      previous.handle.cancel();
      entries.delete(delivery.envelopeId);
    }
    if (entries.size >= MAX_TRACKED_PER_RECIPIENT) {
      const [oldestId, oldest] = entries.entries().next().value as [string, Entry];
      oldest.handle.cancel();
      entries.delete(oldestId);
    }
    const entry: Entry = { delivery, handle: { cancel: () => undefined } };
    entries.set(delivery.envelopeId, entry);
    if (delivery.watch) {
      entry.handle = this.timer.after(UNACKED_REQUEST_MS, () => {
        entry.handle = this.timer.after(ACK_WINDOW_MS - UNACKED_REQUEST_MS, () =>
          this.#forget(entry),
        );
        this.onUnacked(delivery);
      });
    } else {
      entry.handle = this.timer.after(ACK_WINDOW_MS, () => this.#forget(entry));
    }
  }

  /**
   * Settles the ids `recipient` acked and groups them by sender. Ids the recipient was
   * never sent (or that were forgotten) are ignored, so an `ack` cannot reach a device
   * outside the recipient's own deliveries.
   */
  ack(recipient: string, ids: readonly string[]): Map<string, string[]> {
    const bySender = new Map<string, string[]>();
    const entries = this.#byRecipient.get(recipient);
    if (entries === undefined) return bySender;
    for (const id of ids) {
      const entry = entries.get(id);
      if (entry === undefined) continue;
      entry.handle.cancel();
      entries.delete(id);
      const list = bySender.get(entry.delivery.from);
      if (list === undefined) bySender.set(entry.delivery.from, [id]);
      else list.push(id);
    }
    if (entries.size === 0) this.#byRecipient.delete(recipient);
    return bySender;
  }

  /** Deliveries still awaiting an ack (tests, metrics). */
  get size(): number {
    let total = 0;
    for (const entries of this.#byRecipient.values()) total += entries.size;
    return total;
  }

  /** Cancels every timer (shutdown). */
  clear(): void {
    for (const entries of this.#byRecipient.values()) {
      for (const entry of entries.values()) entry.handle.cancel();
    }
    this.#byRecipient.clear();
  }

  #forget(entry: Entry): void {
    const entries = this.#byRecipient.get(entry.delivery.to);
    if (entries?.get(entry.delivery.envelopeId) !== entry) return;
    entries.delete(entry.delivery.envelopeId);
    if (entries.size === 0) this.#byRecipient.delete(entry.delivery.to);
  }
}
