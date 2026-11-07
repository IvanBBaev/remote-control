import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogger, createMemoryDestination } from '@remote-control/log';
import { fastify, type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { DrainState } from '../core/drain-state.js';
import { registerSecurityHeaders } from './security-headers.js';

describe('security headers', () => {
  let dir: string;
  let app: FastifyInstance;

  const build = (hsts: boolean | undefined) =>
    buildApp({
      logger: createLogger({ level: 'silent', destination: createMemoryDestination() }),
      clock: { now: () => 1_000_000 },
      database: { check: () => Promise.resolve('ok'), close: () => Promise.resolve() },
      drain: new DrainState(),
      version: '1.2.3',
      commit: 'abc123',
      publicDir: dir,
      hsts,
    });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-relay-headers-'));
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>rc</title>');
    await writeFile(join(dir, 'sw.js'), 'self.addEventListener("push", () => {});');
    app = await build(undefined);
  });

  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['the PWA', '/', 200],
    ['the service worker', '/sw.js', 200],
    ['the health probe', '/health', 200],
    ['an unknown API path', '/api/unknown', 404],
  ])('sets them on %s', async (_name, url, status) => {
    const res = await app.inject(url);
    expect(res.statusCode).toBe(status);
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['permissions-policy']).toContain('publickey-credentials-get=(self)');
  });

  it('sends HSTS only when asked to', async () => {
    expect((await app.inject('/')).headers['strict-transport-security']).toBeUndefined();
    const production = await build(true);
    try {
      const res = await production.inject('/api/unknown');
      expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
    } finally {
      await production.close();
    }
  });

  it.each([
    ['https://remotectl.dev', "connect-src 'self' wss://remotectl.dev;"],
    ['http://localhost:3000', "connect-src 'self' ws://localhost:3000;"],
    [undefined, "connect-src 'self';"],
  ])('limits connections to the relay for origin %s', async (origin, directive) => {
    const bare = fastify();
    registerSecurityHeaders(bare, { origin, hsts: false });
    bare.get('/', () => 'ok');
    try {
      const res = await bare.inject('/');
      expect(res.headers['content-security-policy']).toContain(directive);
    } finally {
      await bare.close();
    }
  });
});
