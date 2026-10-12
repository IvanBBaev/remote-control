import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogger, createMemoryDestination } from '@remote-control/log';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp, type AppDeps } from './app.js';
import { DrainState } from './core/drain-state.js';
import type { DatabaseStatus } from './core/health-report.js';
import type { DatabaseHealth } from './ports/database-health.js';

class FakeDatabase implements DatabaseHealth {
  status: DatabaseStatus = 'ok';
  checks = 0;
  check(): Promise<DatabaseStatus> {
    this.checks += 1;
    return Promise.resolve(this.status);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

function deps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    logger: createLogger({ level: 'silent', destination: createMemoryDestination() }),
    clock: fakeClock(),
    database: new FakeDatabase(),
    drain: new DrainState(),
    version: '1.2.3',
    commit: 'abc123',
    publicDir: undefined,
    ...overrides,
  };
}

describe('GET /health', () => {
  it('answers 200 with version, commit, uptime and db while serving', async () => {
    const clock = fakeClock();
    const app = await buildApp(deps({ clock }));
    clock.advance(42_500);
    const res = await app.inject('/health');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({
      status: 'ok',
      version: '1.2.3',
      commit: 'abc123',
      uptimeSec: 42,
      db: 'ok',
    });
    await app.close();
  });

  it('answers 503 degraded when the database check fails', async () => {
    const database = new FakeDatabase();
    database.status = 'error';
    const app = await buildApp(deps({ database }));
    const res = await app.inject('/health');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'degraded', db: 'error' });
    await app.close();
  });

  it('reports a disabled database (development) as healthy', async () => {
    const database = new FakeDatabase();
    database.status = 'disabled';
    const app = await buildApp(deps({ database }));
    const res = await app.inject('/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', db: 'disabled' });
    await app.close();
  });

  it('answers 503 draining without probing the database once draining starts (D15)', async () => {
    const drain = new DrainState();
    const database = new FakeDatabase();
    const app = await buildApp(deps({ drain, database }));
    expect((await app.inject('/health')).statusCode).toBe(200);

    drain.begin();
    const res = await app.inject('/health');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'draining', db: 'skipped' });
    expect(database.checks).toBe(1);
    await app.close();
  });

  it('starts draining when the app begins to close', async () => {
    const drain = new DrainState();
    const app = await buildApp(deps({ drain }));
    await app.close();
    expect(drain.isDraining()).toBe(true);
  });

  it('logs the Railway request id as req_id', async () => {
    const destination = createMemoryDestination();
    const logger = createLogger({ level: 'info', destination, timestamp: false });
    const app = await buildApp(deps({ logger }));
    await app.inject({ url: '/api/version', headers: { 'x-railway-request-id': 'rw-1' } });
    await app.inject('/health');
    await app.close();
    const lines = destination.lines().map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.some((line) => line.req_id === 'rw-1')).toBe(true);
    // Health pings stay out of the info log (03 §5.12).
    expect(destination.lines().some((line) => line.includes('/health'))).toBe(false);
  });
});

describe('GET /api/version', () => {
  it('returns the build identity and the protocol range', async () => {
    const app = await buildApp(deps({ commit: null }));
    const res = await app.inject('/api/version');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      version: '1.2.3',
      commit: null,
      protocol: { id: 'rc/v1', v: 1, minSupported: 1 },
    });
    await app.close();
  });
});

describe('static PWA and SPA fallback', () => {
  let dir: string;
  let app: FastifyInstance;
  const html = { accept: 'text/html,application/xhtml+xml' };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-relay-public-'));
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>rc</title>');
    await writeFile(join(dir, 'sw.js'), 'self.addEventListener("push", () => {});');
    await writeFile(join(dir, 'assets', 'app-abc123.js'), 'console.log(1);');
    app = await buildApp(deps({ publicDir: dir }));
  });

  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('serves index.html at / with no-cache', async () => {
    const res = await app.inject({ url: '/', headers: html });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>rc</title>');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('serves hashed assets as immutable and the service worker as no-cache', async () => {
    const asset = await app.inject('/assets/app-abc123.js');
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const sw = await app.inject('/sw.js');
    expect(sw.headers['cache-control']).toBe('no-cache');
  });

  it('falls back to index.html for client routes that accept HTML', async () => {
    const res = await app.inject({ url: '/sessions/42?tab=diff', headers: html });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toContain('<title>rc</title>');
  });

  it.each(['/api/nope', '/api', '/ws/x', '/health/deep'])(
    'answers JSON 404 for server path %s even when HTML is accepted',
    async (url) => {
      const res = await app.inject({ url, headers: html });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
    },
  );

  it('answers JSON 404 for non-HTML and non-GET requests', async () => {
    expect((await app.inject('/missing.js')).json()).toEqual({ error: 'not_found' });
    const post = await app.inject({ method: 'POST', url: '/somewhere', headers: html });
    expect(post.statusCode).toBe(404);
    expect(post.json()).toEqual({ error: 'not_found' });
  });

  it('tolerates a missing PWA build', async () => {
    const bare = await buildApp(deps({ publicDir: join(dir, 'does-not-exist') }));
    const res = await bare.inject({ url: '/', headers: html });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
    expect((await bare.inject('/health')).statusCode).toBe(200);
    await bare.close();
  });
});
