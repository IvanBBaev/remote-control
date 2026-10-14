import type { Clock } from '@remote-control/protocol';

import type { DeviceKind } from '../ports/device-directory.js';
import type { AttachResult, HubConnection, HubPort } from '../ports/hub.js';

/** Presence change times kept for `/api/state?since=`; oldest are dropped beyond this. */
export const MAX_PRESENCE_ENTRIES = 100_000;

/** The in-memory hub of a single relay replica (D15). */
export class LocalHub implements HubPort {
  readonly #users = new Map<string, Map<string, HubConnection>>();
  readonly #changedAt = new Map<string, number>();

  constructor(
    private readonly clock: Clock,
    private readonly deviceCap: number,
    private readonly maxPresenceEntries = MAX_PRESENCE_ENTRIES,
  ) {}

  attach(connection: HubConnection): AttachResult {
    const { userId, deviceId } = connection.identity;
    let devices = this.#users.get(userId);
    const superseded = devices?.get(deviceId);
    if (superseded === undefined && (devices?.size ?? 0) >= this.deviceCap) {
      return { ok: false, reason: 'device_cap' };
    }
    if (devices === undefined) {
      devices = new Map();
      this.#users.set(userId, devices);
    }
    devices.set(deviceId, connection);
    this.#touch(deviceId);
    return { ok: true, superseded };
  }

  detach(connection: HubConnection): boolean {
    const { userId, deviceId } = connection.identity;
    const devices = this.#users.get(userId);
    if (devices?.get(deviceId) !== connection) return false;
    devices.delete(deviceId);
    if (devices.size === 0) this.#users.delete(userId);
    this.#touch(deviceId);
    return true;
  }

  connection(userId: string, deviceId: string): HubConnection | undefined {
    return this.#users.get(userId)?.get(deviceId);
  }

  connections(userId: string): readonly HubConnection[] {
    return [...(this.#users.get(userId)?.values() ?? [])];
  }

  count(userId: string): number {
    return this.#users.get(userId)?.size ?? 0;
  }

  online(kind: DeviceKind): number {
    let total = 0;
    for (const devices of this.#users.values()) {
      for (const connection of devices.values()) if (connection.identity.kind === kind) total += 1;
    }
    return total;
  }

  presenceChangedAt(deviceId: string): number | undefined {
    return this.#changedAt.get(deviceId);
  }

  /** Every connection of every user. */
  all(): readonly HubConnection[] {
    return [...this.#users.values()].flatMap((devices) => [...devices.values()]);
  }

  closeAll(code: number, reason: string): readonly HubConnection[] {
    const all = this.all();
    this.#users.clear();
    for (const connection of all) connection.close(code, reason);
    return all;
  }

  #touch(deviceId: string): void {
    this.#changedAt.delete(deviceId);
    this.#changedAt.set(deviceId, this.clock.now());
    if (this.#changedAt.size > this.maxPresenceEntries) {
      const oldest = this.#changedAt.keys().next().value as string;
      this.#changedAt.delete(oldest);
    }
  }
}
