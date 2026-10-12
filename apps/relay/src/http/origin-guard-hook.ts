import type { FastifyInstance } from 'fastify';

import { checkOrigin } from '../core/origin-guard.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Applies the Origin / `Sec-Fetch-Site` / `X-RC-Client` check (D8) to every
 * state-changing `/api/` request before body parsing: a failure is 403 and is logged
 * as a reason code only.
 */
export function registerOriginGuard(app: FastifyInstance, origin: string): void {
  app.addHook('onRequest', async (request, reply) => {
    if (SAFE_METHODS.has(request.method) || !request.url.startsWith('/api/')) return;
    // An agent authenticates with `Authorization: Bearer` and no cookie: no ambient
    // credential to forge, and a cross-site page cannot set that header without a
    // preflight the relay never grants. Such a request still fails on any cookie route.
    if (request.headers.authorization !== undefined && request.headers.cookie === undefined) {
      return;
    }
    const failure = checkOrigin(
      {
        origin: header(request.headers.origin),
        secFetchSite: header(request.headers['sec-fetch-site']),
        client: header(request.headers['x-rc-client']),
      },
      origin,
    );
    if (failure === null) return;
    request.log.warn({ event: 'origin_rejected', reason: failure }, 'request rejected');
    await reply.code(403).header('cache-control', 'no-store').send({ error: 'forbidden' });
  });
}
