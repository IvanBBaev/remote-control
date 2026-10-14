import type { PGlite } from '@electric-sql/pglite';

import type { Notification, NotifyBus } from '../ports/notify-bus.js';

/**
 * `NotifyBus` on PGlite for tests and the harness: several hubs on one PGlite instance
 * behave like replicas on one Postgres. PGlite is a single connection that never drops,
 * so `onReconnect` never fires.
 */
export function createPgliteNotifyBus(client: PGlite): NotifyBus {
  const unlisteners: (() => Promise<void>)[] = [];
  let queue: Promise<void> = Promise.resolve();
  return {
    async listen(channels, onMessage) {
      for (const channel of channels) {
        unlisteners.push(await client.listen(channel, (payload) => onMessage(channel, payload)));
      }
    },
    publish(notifications: readonly Notification[]) {
      const run = queue.then(() =>
        client.transaction(async (tx) => {
          for (const { channel, payload } of notifications) {
            await tx.query('SELECT pg_notify($1, $2)', [channel, payload]);
          }
        }),
      );
      queue = run.catch(() => undefined);
      return run.then(() => undefined);
    },
    onReconnect: () => undefined,
    async close() {
      await queue;
      for (const unlisten of unlisteners.splice(0)) await unlisten();
    },
  };
}
