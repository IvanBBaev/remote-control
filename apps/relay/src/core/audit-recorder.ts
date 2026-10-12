import { fromHex } from '@remote-control/crypto';
import type { Clock } from '@remote-control/protocol';
import type { Logger } from 'pino';

import type { AuditLogStore, AuditRow } from '../ports/audit-log.js';
import type { DeviceIdentity } from '../ports/device-directory.js';
import type { AuditSink } from '../ports/relay-seams.js';

export interface AuditRecorderDeps {
  readonly clock: Clock;
  readonly store: AuditLogStore;
  readonly logger: Logger;
}

/**
 * The relay's {@link AuditSink} (M1-13): each call becomes one `audit_log` row written in
 * the background. A failed write is logged (event and error class only, D19) and
 * dropped — the audit log is best-effort and never blocks or fails routing.
 */
export class AuditRecorder implements AuditSink {
  readonly #inFlight = new Set<Promise<void>>();

  constructor(private readonly deps: AuditRecorderDeps) {}

  decisionForwarded(sender: DeviceIdentity, decisionHash: string): void {
    this.#write({
      userId: sender.userId,
      deviceId: sender.deviceId,
      event: 'decision_forwarded',
      decisionHash: fromHex(decisionHash),
      at: this.deps.clock.now(),
    });
  }

  pushSent(userId: string, phoneDeviceId: string): void {
    this.#write({ userId, deviceId: phoneDeviceId, event: 'push_sent', at: this.deps.clock.now() });
  }

  /** Resolves once every write started so far has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.all([...this.#inFlight]);
  }

  #write(row: AuditRow): void {
    const task = this.deps.store.append([row]).catch((error: unknown) => {
      this.deps.logger.warn(
        {
          event: 'audit_write_failed',
          audit_event: row.event,
          err: error instanceof Error ? error.name : typeof error,
        },
        'audit row not written',
      );
    });
    this.#inFlight.add(task);
    void task.finally(() => this.#inFlight.delete(task));
  }
}
