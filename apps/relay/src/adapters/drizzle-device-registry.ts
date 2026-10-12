import { and, count, eq, gt, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';

import { agentTokens, auditLog, devices, pairings, pairingSlots, sessions } from '../db/schema.js';
import type { RelayDatabase } from '../ports/db.js';
import type { DeviceRegistry, PairingSlotRecord } from '../ports/device-registry.js';

/** Audit events written by enrolment and pairing (02 §5.6): event, user, device, time only (D19). */
export type DeviceAuditEvent =
  'phone_enrolled' | 'agent_enrolled' | 'agent_token_rotated' | 'pairing_completed';

const date = (ms: number) => new Date(ms);

const slotColumns = {
  id: pairingSlots.id,
  userId: pairingSlots.userId,
  agentDeviceId: pairingSlots.agentDeviceId,
  expiresAt: pairingSlots.expiresAt,
  joinedAt: pairingSlots.joinedAt,
  phoneDeviceId: pairingSlots.phoneDeviceId,
  failedAttempts: pairingSlots.failedAttempts,
};

interface SlotRow {
  id: string;
  userId: string;
  agentDeviceId: string;
  expiresAt: Date;
  joinedAt: Date | null;
  phoneDeviceId: string | null;
  failedAttempts: number;
}

function slotRecord(row: SlotRow): PairingSlotRecord {
  return {
    id: row.id,
    userId: row.userId,
    agentDeviceId: row.agentDeviceId,
    expiresAt: row.expiresAt.getTime(),
    joinedAt: row.joinedAt === null ? null : row.joinedAt.getTime(),
    phoneDeviceId: row.phoneDeviceId,
    failedAttempts: row.failedAttempts,
  };
}

type Tx = Parameters<Parameters<RelayDatabase['transaction']>[0]>[0];

async function liveDevices(tx: Tx, userId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(devices)
    .where(and(eq(devices.userId, userId), isNull(devices.revokedAt)));
  return row?.n ?? 0;
}

function audit(tx: Tx, userId: string, deviceId: string, event: DeviceAuditEvent, now: number) {
  return tx.insert(auditLog).values({ userId, deviceId, event, at: date(now) });
}

/** The `DeviceRegistry` over drizzle; timestamps come from the Clock port, never `now()`. */
export function createDrizzleDeviceRegistry(orm: RelayDatabase): DeviceRegistry {
  return {
    bindPhone(input) {
      return orm.transaction(async (tx) => {
        const [bound] = await tx
          .select({ deviceId: devices.id })
          .from(sessions)
          .innerJoin(devices, eq(devices.id, sessions.deviceId))
          .where(
            and(
              eq(sessions.id, input.sessionId),
              eq(devices.userId, input.userId),
              eq(devices.kind, 'phone'),
              isNull(devices.revokedAt),
            ),
          );
        if (bound !== undefined) return { ok: true, deviceId: bound.deviceId, created: false };

        let deviceId: string;
        let created = false;
        if (input.deviceId !== undefined) {
          const [device] = await tx
            .select({ id: devices.id })
            .from(devices)
            .where(
              and(
                eq(devices.id, input.deviceId),
                eq(devices.userId, input.userId),
                eq(devices.kind, 'phone'),
                isNull(devices.revokedAt),
              ),
            );
          if (device === undefined) return { ok: false, reason: 'unknown_device' };
          deviceId = device.id;
        } else {
          if ((await liveDevices(tx, input.userId)) >= input.cap) {
            return { ok: false, reason: 'device_cap' };
          }
          const [device] = await tx
            .insert(devices)
            .values({
              userId: input.userId,
              kind: 'phone',
              name: input.name,
              createdAt: date(input.now),
            })
            .returning({ id: devices.id });
          deviceId = device!.id;
          created = true;
          await audit(tx, input.userId, deviceId, 'phone_enrolled', input.now);
        }
        await tx
          .update(sessions)
          .set({ deviceId })
          .where(and(eq(sessions.id, input.sessionId), eq(sessions.userId, input.userId)));
        return { ok: true, deviceId, created };
      });
    },

    enrolAgent(input) {
      return orm.transaction(async (tx) => {
        if ((await liveDevices(tx, input.userId)) >= input.cap) return null;
        const [device] = await tx
          .insert(devices)
          .values({
            userId: input.userId,
            kind: 'agent',
            name: input.name,
            createdAt: date(input.now),
          })
          .returning({ id: devices.id });
        const deviceId = device!.id;
        await tx.insert(agentTokens).values({
          userId: input.userId,
          agentDeviceId: deviceId,
          tokenHash: input.tokenHash,
          createdAt: date(input.now),
        });
        await audit(tx, input.userId, deviceId, 'agent_enrolled', input.now);
        return { deviceId };
      });
    },

    rotateAgentToken(input) {
      return orm.transaction(async (tx) => {
        const revoked = await tx
          .update(agentTokens)
          .set({ revokedAt: date(input.now) })
          .where(
            and(
              eq(agentTokens.tokenHash, input.oldTokenHash),
              eq(agentTokens.agentDeviceId, input.agentDeviceId),
              eq(agentTokens.userId, input.userId),
              isNull(agentTokens.revokedAt),
            ),
          )
          .returning({ id: agentTokens.id });
        if (revoked.length === 0) return false;
        await tx.insert(agentTokens).values({
          userId: input.userId,
          agentDeviceId: input.agentDeviceId,
          tokenHash: input.newTokenHash,
          createdAt: date(input.now),
        });
        await audit(tx, input.userId, input.agentDeviceId, 'agent_token_rotated', input.now);
        return true;
      });
    },

    openSlot(input) {
      return orm.transaction(async (tx) => {
        await tx
          .delete(pairingSlots)
          .where(
            or(
              eq(pairingSlots.agentDeviceId, input.agentDeviceId),
              lte(pairingSlots.expiresAt, date(input.now)),
            ),
          );
        const [taken] = await tx
          .select({ id: pairingSlots.id })
          .from(pairingSlots)
          .where(eq(pairingSlots.codeHash, input.codeHash));
        if (taken !== undefined) return null;
        const [row] = await tx
          .insert(pairingSlots)
          .values({
            userId: input.userId,
            agentDeviceId: input.agentDeviceId,
            codeHash: input.codeHash,
            createdAt: date(input.now),
            expiresAt: date(input.expiresAt),
          })
          .returning(slotColumns);
        return slotRecord(row!);
      });
    },

    async joinSlot(input) {
      const [row] = await orm
        .select(slotColumns)
        .from(pairingSlots)
        .innerJoin(devices, eq(devices.id, pairingSlots.agentDeviceId))
        .where(
          and(
            eq(pairingSlots.codeHash, input.codeHash),
            eq(pairingSlots.userId, input.userId),
            isNull(devices.revokedAt),
          ),
        );
      if (row === undefined) return { ok: false, slot: undefined };
      const [joined] = await orm
        .update(pairingSlots)
        .set({ joinedAt: date(input.now), phoneDeviceId: input.phoneDeviceId })
        .where(
          and(
            eq(pairingSlots.id, row.id),
            isNull(pairingSlots.joinedAt),
            gt(pairingSlots.expiresAt, date(input.now)),
            lt(pairingSlots.failedAttempts, input.maxFailures),
          ),
        )
        .returning(slotColumns);
      return joined === undefined
        ? { ok: false, slot: slotRecord(row) }
        : { ok: true, slot: slotRecord(joined) };
    },

    async findSlot(slotId, agentDeviceId) {
      const [row] = await orm
        .select(slotColumns)
        .from(pairingSlots)
        .where(and(eq(pairingSlots.id, slotId), eq(pairingSlots.agentDeviceId, agentDeviceId)));
      return row && slotRecord(row);
    },

    completeSlot(input) {
      const { slot } = input;
      return orm.transaction(async (tx) => {
        const deleted = await tx
          .delete(pairingSlots)
          .where(
            and(
              eq(pairingSlots.id, slot.id),
              eq(pairingSlots.phoneDeviceId, input.phoneDeviceId),
              isNotNull(pairingSlots.joinedAt),
            ),
          )
          .returning({ id: pairingSlots.id });
        if (deleted.length === 0) return null;
        const [phone] = await tx
          .select({ id: devices.id })
          .from(devices)
          .where(
            and(
              eq(devices.id, input.phoneDeviceId),
              eq(devices.userId, slot.userId),
              isNull(devices.revokedAt),
            ),
          );
        if (phone === undefined) return null;
        const [pairing] = await tx
          .insert(pairings)
          .values({
            userId: slot.userId,
            phoneDeviceId: input.phoneDeviceId,
            agentDeviceId: slot.agentDeviceId,
            createdAt: date(input.now),
          })
          .onConflictDoUpdate({
            target: [pairings.phoneDeviceId, pairings.agentDeviceId],
            set: { revokedAt: null, createdAt: date(input.now) },
          })
          .returning({ id: pairings.id });
        await audit(tx, slot.userId, slot.agentDeviceId, 'pairing_completed', input.now);
        return { pairingId: pairing!.id };
      });
    },

    async failSlot(slotId, phoneDeviceId) {
      const [row] = await orm
        .update(pairingSlots)
        .set({
          failedAttempts: sql`${pairingSlots.failedAttempts} + 1`,
          joinedAt: null,
          phoneDeviceId: null,
        })
        .where(and(eq(pairingSlots.id, slotId), eq(pairingSlots.phoneDeviceId, phoneDeviceId)))
        .returning({ failedAttempts: pairingSlots.failedAttempts });
      return row === undefined ? null : row.failedAttempts;
    },

    async deleteSlot(slotId) {
      await orm.delete(pairingSlots).where(eq(pairingSlots.id, slotId));
    },
  };
}
