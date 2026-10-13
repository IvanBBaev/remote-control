import { and, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';

import {
  agentTokens,
  auditLog,
  devices,
  inviteCodes,
  pairings,
  pairingSlots,
  pushSubscriptions,
  sessions,
  users,
} from '../db/schema.js';
import type { RelayDatabase } from '../ports/db.js';
import type { DeviceRevocations } from '../ports/device-revocations.js';

const date = (ms: number) => new Date(ms);

/** The `DeviceRevocations` over drizzle; timestamps come from the Clock port, never `now()`. */
export function createDrizzleDeviceRevocations(orm: RelayDatabase): DeviceRevocations {
  return {
    revokeDevice({ userId, deviceId, kinds, now }) {
      return orm.transaction(async (tx) => {
        const [device] = await tx
          .update(devices)
          .set({ revokedAt: date(now) })
          .where(
            and(
              eq(devices.id, deviceId),
              eq(devices.userId, userId),
              inArray(devices.kind, [...kinds]),
              isNull(devices.revokedAt),
            ),
          )
          .returning({ kind: devices.kind });
        if (device === undefined) return null;
        await tx
          .update(pairings)
          .set({ revokedAt: date(now) })
          .where(
            and(
              eq(pairings.userId, userId),
              isNull(pairings.revokedAt),
              or(eq(pairings.phoneDeviceId, deviceId), eq(pairings.agentDeviceId, deviceId)),
            ),
          );
        await tx.delete(sessions).where(eq(sessions.deviceId, deviceId));
        await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.deviceId, deviceId));
        await tx.delete(agentTokens).where(eq(agentTokens.agentDeviceId, deviceId));
        await tx
          .delete(pairingSlots)
          .where(
            or(eq(pairingSlots.agentDeviceId, deviceId), eq(pairingSlots.phoneDeviceId, deviceId)),
          );
        await tx
          .insert(auditLog)
          .values({ userId, deviceId, event: 'device_revoked', at: date(now) });
        return device.kind as 'phone' | 'agent';
      });
    },

    async revokedPeers(agentDeviceId) {
      const rows = await orm
        .select({ phoneDeviceId: pairings.phoneDeviceId })
        .from(pairings)
        .where(and(eq(pairings.agentDeviceId, agentDeviceId), isNotNull(pairings.revokedAt)));
      return rows.map((row) => row.phoneDeviceId);
    },

    deleteAccount(userId) {
      return orm.transaction(async (tx) => {
        const owned = await tx
          .select({ id: devices.id })
          .from(devices)
          .where(eq(devices.userId, userId));
        const deviceIds = owned.map((row) => row.id);
        await tx
          .delete(auditLog)
          .where(
            deviceIds.length === 0
              ? eq(auditLog.userId, userId)
              : or(eq(auditLog.userId, userId), inArray(auditLog.deviceId, deviceIds)),
          );
        await tx.delete(inviteCodes).where(eq(inviteCodes.usedByUserId, userId));
        const deleted = await tx
          .delete(users)
          .where(eq(users.id, userId))
          .returning({ id: users.id });
        return deleted.length > 0;
      });
    },
  };
}
