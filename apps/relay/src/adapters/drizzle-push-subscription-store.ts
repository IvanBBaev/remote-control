import { and, asc, eq, inArray } from 'drizzle-orm';

import { devices, pushSubscriptions } from '../db/schema.js';
import type { RelayDatabase } from '../ports/db.js';
import type { ApnsEnvironment } from '../ports/push.js';
import type {
  PushSubscriptionRecord,
  PushSubscriptionStore,
} from '../ports/push-subscription-store.js';

const columns = {
  id: pushSubscriptions.id,
  deviceId: pushSubscriptions.deviceId,
  kind: pushSubscriptions.kind,
  endpoint: pushSubscriptions.endpoint,
  p256dh: pushSubscriptions.p256dh,
  auth: pushSubscriptions.auth,
  apnsEnvironment: pushSubscriptions.apnsEnvironment,
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
        const keys =
          subscription.kind === 'webpush'
            ? { p256dh: subscription.p256dh, auth: subscription.auth, apnsEnvironment: null }
            : { p256dh: null, auth: null, apnsEnvironment: subscription.environment };
        const values = {
          deviceId: subscription.deviceId,
          kind: subscription.kind,
          ...keys,
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
          .where(
            and(
              eq(pushSubscriptions.deviceId, subscription.deviceId),
              eq(pushSubscriptions.kind, subscription.kind),
            ),
          )
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
      return rows.flatMap((row) => {
        const record = toRecord(row);
        return record === undefined ? [] : [record];
      });
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

type Row = {
  readonly id: string;
  readonly deviceId: string;
  readonly kind: string;
  readonly endpoint: string;
  readonly p256dh: string | null;
  readonly auth: string | null;
  readonly apnsEnvironment: string | null;
  readonly createdAt: Date;
  readonly lastFailureAt: Date | null;
};

/** Maps a row to its kind; the table's check constraint makes `undefined` unreachable. */
function toRecord(row: Row): PushSubscriptionRecord | undefined {
  const stored = {
    id: row.id,
    deviceId: row.deviceId,
    endpoint: row.endpoint,
    createdAt: row.createdAt.getTime(),
    lastFailureAt: row.lastFailureAt === null ? null : row.lastFailureAt.getTime(),
  };
  if (row.kind === 'webpush' && row.p256dh !== null && row.auth !== null) {
    return { ...stored, kind: 'webpush', p256dh: row.p256dh, auth: row.auth };
  }
  if (
    (row.kind === 'apns' || row.kind === 'apns_activity') &&
    (row.apnsEnvironment === 'sandbox' || row.apnsEnvironment === 'production')
  ) {
    const environment: ApnsEnvironment = row.apnsEnvironment;
    return { ...stored, kind: row.kind, environment };
  }
  return undefined;
}
