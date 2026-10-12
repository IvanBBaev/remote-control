import { EventEmitter } from 'node:events';

import { assertNoCanary, createLogger, createMemoryDestination } from '@remote-control/log';
import type { Random } from '@remote-control/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createSentryReporter } from './adapters/sentry-reporter.js';
import { buildApp } from './app.js';
import { DrainState } from './core/drain-state.js';
import { parseSentryDsn } from './core/sentry-dsn.js';
import { installCrashHandlers } from './crash-handlers.js';
import type { ErrorReporter } from './ports/error-reporter.js';

const CANARY = 'CANARY7f3a9c2e1b';
const ones: Random = { bytes: (n) => new Uint8Array(n).fill(1) };

function recordingReporter() {
  const dsn = parseSentryDsn('https://pubkey@o1.ingest.sentry.io/42');
  if (dsn === null) throw new Error('bad test DSN');
  const bodies: string[] = [];
  const reporter = createSentryReporter({
    dsn,
    release: 'abc123',
    environment: 'test',
    clock: { now: () => 1_000 },
    random: ones,
    logger: createLogger({ level: 'silent', destination: createMemoryDestination() }),
    fetch: ((_url: string, init: RequestInit) => {
      bodies.push(init.body as string);
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch,
  });
  return { reporter, bodies };
}

describe('error reporting (M0-26)', () => {
  it('reports a 5xx with route metadata only and never the request payload', async () => {
    const { reporter, bodies } = recordingReporter();
    const app = await buildApp({
      logger: createLogger({ level: 'silent', destination: createMemoryDestination() }),
      clock: { now: () => 1_000 },
      database: { check: () => Promise.resolve('ok'), close: () => Promise.resolve() },
      drain: new DrainState(),
      version: '1.2.3',
      commit: 'abc123',
      publicDir: undefined,
      errors: reporter,
    });
    app.post('/test/boom/:id', (request) => {
      const body = request.body as { secret: string };
      throw new Error(
        `handler failed on "${body.secret}" for ${request.headers['x-token'] as string}`,
      );
    });
    app.post('/test/bad', () => {
      throw Object.assign(new Error('bad request'), { statusCode: 400 });
    });
    const res = await app.inject({
      method: 'POST',
      url: `/test/boom/${CANARY}?q=${CANARY}`,
      headers: { 'x-token': `tok_${CANARY}`, 'x-request-id': CANARY },
      payload: { secret: CANARY },
    });
    expect(res.statusCode).toBe(500);
    expect((await app.inject({ method: 'POST', url: '/test/bad' })).statusCode).toBe(400);
    await reporter.flush(1_000);
    await app.close();

    expect(bodies).toHaveLength(1);
    assertNoCanary(bodies, [CANARY]);
    const event = JSON.parse(String(bodies[0]?.trimEnd().split('\n')[2])) as {
      tags: Record<string, string>;
    };
    expect(event.tags).toMatchObject({
      event: 'http_error',
      method: 'POST',
      route: '/test/boom/:id',
    });
  });

  it('captures the first crash, flushes and exits 1', async () => {
    const source = new EventEmitter();
    const captured: string[] = [];
    let release: (value: boolean) => void = () => undefined;
    const errors: ErrorReporter = {
      capture: (_error, context) => captured.push(context.event),
      flush: () => new Promise<boolean>((resolve) => (release = resolve)),
    };
    const exit = vi.fn();
    const destination = createMemoryDestination();
    installCrashHandlers({
      source,
      errors,
      logger: createLogger({ level: 'info', destination }),
      exit,
    });
    source.emit('uncaughtException', new Error('first'));
    source.emit('unhandledRejection', new Error('second'));
    expect(captured).toEqual(['uncaught_exception']);
    expect(exit).not.toHaveBeenCalled();
    release(true);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(exit).toHaveBeenCalledTimes(1);
    const logged = destination.lines().join('\n');
    expect(logged).toMatch(/"event":"uncaught_exception"/);
    expect(logged).toMatch(/"event":"unhandled_rejection"/);
  });
});
