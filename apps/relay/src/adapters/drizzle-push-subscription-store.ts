import { and, asc, eq, inArray } from 'drizzle-orm';

import { devices, pushSubscriptions } from '../db/schema.js';
import type { RelayDatabase } from '../ports/db.js';
import type { PushSubscriptionStore } from '../ports/push-subscription-store.js';

const columns = {
  id: pushSubscriptions.id,
  deviceId: pushSubscriptions.deviceId,
  endpoint: pushSubscriptions.endpoint,
  p256dh: pushSubscriptions.p256dh,
  auth: pushSubscriptions.auth,
  createdAt: pushSubscriptions.createdAt,
  lastFailureAt: pushSubscriptions.lastFailureAt,
};

/** The {@link PushSubscriptionStore} over drizzle; timestamps come from the Clock port. */
export function createDrizzlePushSubscriptionStore(orm: RelayDatabase): PushSubscriptionStore {
  return {
    save(subscription, maxPerDevice, now) {
      return orm.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: pushSubscriptions.id, userId: devices.userId })
          .from(pushSubscriptions)
          .innerJoin(devices, eq(devices.id, pushSubscriptions.deviceId))
          .where(eq(pushSubscriptions.endpoint, subscription.endpoint));
        if (existing !== undefined && existing.userId !== subscription.userId) return 'taken';
        const values = {
          deviceId: subscription.deviceId,
          p256dh: subscription.p256dh,
          auth: subscription.auth,
          createdAt: new Date(now),
          lastFailureAt: null,
        };
        if (existing === undefined) {
          await tx.insert(pushSubscriptions).values({ ...values, endpoint: subscription.endpoint });
        } else {
          await tx
            .update(pushSubscriptions)
            .set(values)
            .where(eq(pushSubscriptions.id, existing.id));
        }
        const rows = await tx
          .select({ id: pushSubscriptions.id, endpoint: pushSubscriptions.endpoint })
          .from(pushSubscriptions)
          .where(eq(pushSubscriptions.deviceId, subscription.deviceId))
          .orderBy(asc(pushSubscriptions.createdAt), asc(pushSubscriptions.id));
        const surplus = rows
          .filter((row) => row.endpoint !== subscription.endpoint)
          .slice(0, Math.max(0, rows.length - maxPerDevice))
          .map((row) => row.id);
        if (surplus.length > 0) {
          await tx.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, surplus));
        }
        return 'saved';
      });
    },

    async listForDevice(deviceId) {
      const rows = await orm
        .select(columns)
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.deviceId, deviceId))
        .orderBy(asc(pushSubscriptions.createdAt), asc(pushSubscriptions.id));
      return rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.getTime(),
        lastFailureAt: row.lastFailureAt === null ? null : row.lastFailureAt.getTime(),
      }));
    },

    async removeEndpoint(deviceId, endpoint) {
      const removed = await orm
        .delete(pushSubscriptions)
        .where(
          and(eq(pushSubscriptions.deviceId, deviceId), eq(pushSubscriptions.endpoint, endpoint)),
        )
        .returning({ id: pushSubscriptions.id });
      return removed.length > 0;
    },

    async remove(id) {
      await orm.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id));
    },

    async markFailure(id, now) {
      await orm
        .update(pushSubscriptions)
        .set({ lastFailureAt: new Date(now) })
        .where(eq(pushSubscriptions.id, id));
    },
  };
}
