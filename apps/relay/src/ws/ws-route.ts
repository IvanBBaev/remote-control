import websocket from '@fastify/websocket';
import { sha256, utf8 } from '@remote-control/crypto';
import type { Clock } from '@remote-control/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RawData, WebSocket } from 'ws';

import type { AccountService } from '../core/account-service.js';
import type { DrainState } from '../core/drain-state.js';
import { DEVICE_CAP, MAX_FRAME_BYTES } from '../core/hub-limits.js';
import type { RelayRouter } from '../core/relay-router.js';
import { sessionCookie } from '../core/session-cookie.js';
import type { DeviceDirectory, DeviceIdentity } from '../ports/device-directory.js';
import type { HubPort } from '../ports/hub.js';

export interface WsRouteDeps {
  readonly router: RelayRouter;
  readonly hub: HubPort;
  readonly directory: DeviceDirectory;
  readonly accounts: AccountService;
  readonly drain: DrainState;
  readonly clock: Clock;
  /** The PWA origin (`RC_ORIGIN`) a phone's upgrade must come from (D8). */
  readonly origin: string;
}

/** Longest bearer token accepted (the real ones are far shorter). */
const MAX_TOKEN_LENGTH = 512;
const BEARER = /^Bearer ([\x21-\x7e]+)$/;

/** A text message as a string (`ws` delivers Buffers with the default `binaryType`). */
export function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

type Rejection = 'draining' | 'unauthenticated' | 'origin' | 'device_cap';

const STATUS: Record<Rejection, number> = {
  draining: 503,
  unauthenticated: 401,
  origin: 403,
  device_cap: 429,
};

/**
 * `GET /ws` (D15, 03 §5.1): every check runs in `preValidation`, before the upgrade is
 * accepted, so an unauthenticated peer never gets a socket. An agent presents
 * `Authorization: Bearer <token>` (only its SHA-256 is looked up); a phone presents the
 * session cookie from the PWA origin (Origin and `Sec-Fetch-Site`, D8 — a browser
 * WebSocket cannot send `X-RC-Client`, `SameSite=Strict` and the Origin check stand in).
 */
export async function registerWsRoute(app: FastifyInstance, deps: WsRouteDeps): Promise<void> {
  await app.register(websocket, {
    options: {
      maxPayload: MAX_FRAME_BYTES,
      perMessageDeflate: false,
      clientTracking: false,
    },
  });

  const identities = new WeakMap<FastifyRequest, DeviceIdentity>();

  async function identify(request: FastifyRequest): Promise<DeviceIdentity | Rejection> {
    const authorization = header(request.headers.authorization);
    if (authorization !== undefined) {
      const bearer = BEARER.exec(authorization);
      const token = bearer?.[1];
      if (token === undefined || token.length > MAX_TOKEN_LENGTH) return 'unauthenticated';
      const agent = await deps.directory.authenticateAgent(
        await sha256(utf8(token)),
        deps.clock.now(),
      );
      return agent ?? 'unauthenticated';
    }
    const origin = header(request.headers.origin);
    const site = header(request.headers['sec-fetch-site']);
    if (origin !== deps.origin || (site !== undefined && site !== 'same-origin')) return 'origin';
    const session = await deps.accounts.authenticate(sessionCookie.read(request.headers.cookie));
    if (!session.ok) return 'unauthenticated';
    return (
      (await deps.directory.phoneForSession(session.sessionId, session.userId)) ?? 'unauthenticated'
    );
  }

  async function authorize(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // A plain GET (no upgrade) falls through to the plugin's 404.
    if (!request.ws) return;
    let outcome: DeviceIdentity | Rejection = deps.drain.isDraining()
      ? 'draining'
      : await identify(request);
    if (
      typeof outcome !== 'string' &&
      deps.hub.connection(outcome.userId, outcome.deviceId) === undefined &&
      deps.hub.count(outcome.userId) >= DEVICE_CAP
    ) {
      outcome = 'device_cap';
    }
    if (typeof outcome !== 'string') {
      identities.set(request, outcome);
      return;
    }
    request.log.info({ event: 'ws_rejected', reason: outcome }, 'websocket upgrade rejected');
    await reply.code(STATUS[outcome]).header('cache-control', 'no-store').send({ error: outcome });
  }

  app.get(
    '/ws',
    { websocket: true, preValidation: authorize },
    (socket: WebSocket, request: FastifyRequest) => {
      // preValidation either stores an identity or replies, so the handler always finds one.
      const identity = identities.get(request)!;
      identities.delete(request);
      const events = deps.router.accept(identity, socket);
      request.log.info(
        { event: 'ws_open', device_id: identity.deviceId, kind: identity.kind },
        'device connected',
      );
      socket.on('message', (data, isBinary) => {
        events.message(isBinary ? null : rawText(data));
      });
      socket.on('pong', () => events.pong());
      socket.on('close', (code) => {
        request.log.info(
          { event: 'ws_close', device_id: identity.deviceId, code },
          'device disconnected',
        );
        events.closed();
      });
    },
  );
}
