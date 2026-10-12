import { and, eq, isNull } from 'drizzle-orm';

import { agentTokens, devices, sessions } from '../db/schema.js';
import type { RelayDatabase } from '../ports/db.js';
import type { DeviceDirectory, DeviceKind } from '../ports/device-directory.js';

const date = (ms: number) => new Date(ms);
const ms = (value: Date | null) => (value === null ? null : value.getTime());

/** The `DeviceDirectory` over drizzle; timestamps come from the Clock port, never `now()`. */
export function createDrizzleDeviceDirectory(orm: RelayDatabase): DeviceDirectory {
  return {
    async authenticateAgent(tokenHash, now) {
      const [row] = await orm
        .select({ tokenId: agentTokens.id, userId: devices.userId, deviceId: devices.id })
        .from(agentTokens)
        .innerJoin(devices, eq(devices.id, agentTokens.agentDeviceId))
        .where(
          and(
            eq(agentTokens.tokenHash, tokenHash),
            isNull(agentTokens.revokedAt),
            isNull(devices.revokedAt),
            eq(devices.kind, 'agent'),
            eq(devices.userId, agentTokens.userId),
          ),
        );
      if (row === undefined) return undefined;
      await orm
        .update(agentTokens)
        .set({ lastUsedAt: date(now) })
        .where(eq(agentTokens.id, row.tokenId));
      return { userId: row.userId, deviceId: row.deviceId, kind: 'agent' };
    },

    async phoneForSession(sessionId, userId) {
      const [row] = await orm
        .select({ deviceId: devices.id })
        .from(sessions)
        .innerJoin(devices, eq(devices.id, sessions.deviceId))
        .where(
          and(
            eq(sessions.id, sessionId),
            eq(sessions.userId, userId),
            eq(devices.userId, userId),
            eq(devices.kind, 'phone'),
            isNull(devices.revokedAt),
          ),
        );
      return row && { userId, deviceId: row.deviceId, kind: 'phone' };
    },

    async listDevices(userId) {
      const rows = await orm
        .select({
          id: devices.id,
          kind: devices.kind,
          name: devices.name,
          createdAt: devices.createdAt,
          lastSeenAt: devices.lastSeenAt,
          revokedAt: devices.revokedAt,
        })
        .from(devices)
        .where(eq(devices.userId, userId))
        .orderBy(devices.createdAt, devices.id);
      return rows.map((row) => ({
        id: row.id,
        // The `devices_kind_check` constraint limits the column to these two values.
        kind: row.kind as DeviceKind,
        name: row.name,
        createdAt: row.createdAt.getTime(),
        lastSeenAt: ms(row.lastSeenAt),
        revokedAt: ms(row.revokedAt),
      }));
    },

    async ownerOf(deviceId) {
      const [row] = await orm
        .select({ userId: devices.userId })
        .from(devices)
        .where(and(eq(devices.id, deviceId), isNull(devices.revokedAt)));
      return row?.userId;
    },

    async markSeen(deviceId, now) {
      await orm
        .update(devices)
        .set({ lastSeenAt: date(now) })
        .where(eq(devices.id, deviceId));
    },
  };
}
