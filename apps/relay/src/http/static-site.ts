import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_CACHE = 'no-cache';

/** Paths the SPA never owns: API, WebSocket and the health probe answer JSON 404s. */
function isServerPath(path: string): boolean {
  return /^\/(api|ws|health)(\/|$)/.test(path);
}

function wantsHtml(request: FastifyRequest): boolean {
  return request.method === 'GET' && (request.headers.accept ?? '').includes('text/html');
}

/**
 * Serves the PWA build from one origin with the API (03 §5.11): hashed `/assets/*`
 * are immutable, everything else (`index.html`, `sw.js`, the manifest) is `no-cache`;
 * an unknown `GET` that accepts HTML gets `index.html` (SPA fallback), anything else
 * a JSON 404. A missing build directory is tolerated: only the JSON 404 remains.
 */
export async function registerStaticSite(
  app: FastifyInstance,
  publicDir: string | undefined,
): Promise<void> {
  const hasIndex = publicDir !== undefined && existsSync(join(publicDir, 'index.html'));
  if (hasIndex) {
    const root = resolve(publicDir);
    const assetsDir = join(root, 'assets') + sep;
    await app.register(fastifyStatic, {
      root,
      prefix: '/',
      wildcard: false,
      cacheControl: false,
      setHeaders: (reply, filePath) => {
        reply.header('cache-control', filePath.startsWith(assetsDir) ? IMMUTABLE : NO_CACHE);
      },
    });
  } else {
    app.log.warn({ event: 'static_missing' }, 'PWA build not found; static serving disabled');
  }

  app.setNotFoundHandler(async (request, reply) => {
    const path = request.url.split('?', 1)[0] ?? '/';
    if (hasIndex && wantsHtml(request) && !isServerPath(path)) {
      return reply.header('cache-control', NO_CACHE).sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found' });
  });
}
