import type { Clock } from '@remote-control/protocol';
import type { FastifyInstance } from 'fastify';

import type { AccountService } from '../core/account-service.js';
import { sessionCookie } from '../core/session-cookie.js';
import type { DeviceDirectory, DeviceKind, DeviceRecord } from '../ports/device-directory.js';
import type { HubPort } from '../ports/hub.js';

export interface StateRouteDeps {
  readonly accounts: AccountService;
  readonly directory: DeviceDirectory;
  readonly hub: HubPort;
  readonly clock: Clock;
}

/** One device in `/api/state`; relay-side metadata only (D23, 05 Rec-5). */
export interface DeviceState {
  readonly deviceId: string;
  readonly kind: DeviceKind;
  readonly name: string;
  readonly online: boolean;
  readonly lastSeen: number | null;
  readonly revoked: boolean;
}

export interface StateBody {
  readonly relayTs: number;
  /** Pass back as `since` to get only what changed after this response. */
  readonly cursor: number;
  readonly devices: readonly DeviceState[];
}

const CURSOR = /^\d{1,15}$/;

/** The last instant this device's row or presence changed. */
function changedAt(device: DeviceRecord, presence: number | undefined): number {
  return Math.max(device.createdAt, device.lastSeenAt ?? 0, device.revokedAt ?? 0, presence ?? 0);
}

/**
 * `GET /api/state?since=<cursor>` (D23): the reconnecting PWA's catch-up on relay-side
 * state — the user's devices, who is online and when each was last seen. Without
 * `since` it returns every live device; with it, only devices that changed after the
 * cursor, revoked ones included so the PWA can drop them. Session cookie required.
 */
export function registerStateRoute(app: FastifyInstance, deps: StateRouteDeps): void {
  app.get('/api/state', async (request, reply) => {
    const { since } = request.query as { since?: unknown };
    if (since !== undefined && (typeof since !== 'string' || !CURSOR.test(since))) {
      return reply.code(400).send({ error: 'bad_cursor' });
    }
    const session = await deps.accounts.authenticate(sessionCookie.read(request.headers.cookie));
    if (!session.ok) {
      return reply
        .code(401)
        .header('cache-control', 'no-store')
        .header('set-cookie', sessionCookie.clear())
        .send({ error: 'unauthenticated' });
    }
    const now = deps.clock.now();
    const cursor = since === undefined ? undefined : Number(since);
    const devices = (await deps.directory.listDevices(session.userId))
      .filter((device) =>
        cursor === undefined
          ? device.revokedAt === null
          : changedAt(device, deps.hub.presenceChangedAt(device.id)) > cursor,
      )
      .map((device): DeviceState => {
        const online =
          device.revokedAt === null && deps.hub.connection(session.userId, device.id) !== undefined;
        return {
          deviceId: device.id,
          kind: device.kind,
          name: device.name,
          online,
          lastSeen: online ? now : device.lastSeenAt,
          revoked: device.revokedAt !== null,
        };
      });
    const body: StateBody = { relayTs: now, cursor: now, devices };
    return reply.header('cache-control', 'no-store').send(body);
  });
}
