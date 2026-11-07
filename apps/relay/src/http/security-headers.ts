import type { FastifyInstance } from 'fastify';

export interface SecurityHeadersOptions {
  /** `RC_ORIGIN`; its WebSocket origin joins `connect-src`, no other relay is reachable. */
  readonly origin: string | undefined;
  /** Set by production only: a local `http://` relay must not pin the browser to HTTPS. */
  readonly hsts: boolean;
}

const HSTS = 'max-age=31536000; includeSubDomains';
const PERMISSIONS = [
  'camera=(self)',
  'geolocation=()',
  'microphone=()',
  'publickey-credentials-create=(self)',
  'publickey-credentials-get=(self)',
].join(', ');

function contentSecurityPolicy(origin: string | undefined): string {
  const connect = origin === undefined ? "'self'" : `'self' ${origin.replace(/^http/, 'ws')}`;
  return [
    "default-src 'self'",
    // The QR scanner compiles zxing-wasm from `/assets`.
    "script-src 'self' 'wasm-unsafe-eval'",
    `connect-src ${connect}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Adds the headers to every response (01 F2, 05 F1): API, static files, 404s and errors.
 * Hooks reach only what is registered after them, so this runs before any route.
 */
export function registerSecurityHeaders(
  app: FastifyInstance,
  options: SecurityHeadersOptions,
): void {
  const csp = contentSecurityPolicy(options.origin);
  app.addHook('onSend', async (_request, reply) => {
    reply.header('content-security-policy', csp);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('permissions-policy', PERMISSIONS);
    if (options.hsts) reply.header('strict-transport-security', HSTS);
  });
}
