import { createLogger, createMemoryDestination } from '@remote-control/log';
import type { Random } from '@remote-control/protocol';
import { describe, expect, it } from 'vitest';

import { parseSentryDsn } from '../core/sentry-dsn.js';
import { createSentryReporter, type SentryReporterOptions } from './sentry-reporter.js';

const DSN = parseSentryDsn('https://pubkey@o1.ingest.sentry.io/42');
const ones: Random = { bytes: (n) => new Uint8Array(n).fill(1) };

interface Sent {
  readonly url: string;
  readonly init: RequestInit;
}

function setup(
  overrides: Partial<SentryReporterOptions> = {},
  respond = () => Promise.resolve(new Response(null, { status: 200 })),
) {
  if (DSN === null) throw new Error('bad test DSN');
  const sent: Sent[] = [];
  const destination = createMemoryDestination();
  let now = Date.UTC(2026, 9, 13);
  const fetchStub = ((url: string, init: RequestInit) => {
    sent.push({ url, init });
    return respond();
  }) as unknown as typeof fetch;
  const reporter = createSentryReporter({
    dsn: DSN,
    release: 'abc123',
    environment: 'production',
    clock: { now: () => now },
    random: ones,
    logger: createLogger({ level: 'info', destination }),
    fetch: fetchStub,
    ...overrides,
  });
  return { reporter, sent, destination, advance: (ms: number) => (now += ms) };
}

describe('createSentryReporter', () => {
  it('posts one envelope with the auth header and the allow-listed event', async () => {
    const { reporter, sent } = setup();
    reporter.capture(new Error('boom'), { event: 'http_error', route: '/api/x' });
    expect(await reporter.flush(1_000)).toBe(true);
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request?.url).toBe('https://o1.ingest.sentry.io/api/42/envelope/');
    expect(request?.init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(request?.init.headers).toEqual({
      'content-type': 'application/x-sentry-envelope',
      'x-sentry-auth':
        'Sentry sentry_version=7, sentry_key=pubkey, sentry_client=remote-control-relay/1',
    });
    const lines = (request?.init.body as string)
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual({
      event_id: '01'.repeat(16),
      sent_at: '2026-10-13T00:00:00.000Z',
      dsn: 'https://pubkey@o1.ingest.sentry.io/42',
    });
    expect(lines[1]).toEqual({ type: 'event' });
    expect(lines[2]).toMatchObject({
      event_id: '01'.repeat(16),
      release: 'abc123',
      environment: 'production',
      tags: { event: 'http_error', route: '/api/x' },
    });
  });

  it('flushes immediately when nothing is pending', async () => {
    const { reporter } = setup();
    expect(await reporter.flush(1)).toBe(true);
  });

  it('caps reports per minute and logs how many were dropped', async () => {
    const { reporter, sent, destination, advance } = setup({ perMinute: 2 });
    for (let i = 0; i < 5; i += 1) reporter.capture(new Error('x'), { event: 'x' });
    expect(sent).toHaveLength(2);
    advance(60_000);
    reporter.capture(new Error('x'), { event: 'x' });
    expect(sent).toHaveLength(3);
    await reporter.flush(1_000);
    expect(destination.lines().join('\n')).toMatch(/"event":"sentry_rate_limited","dropped":3/);
  });

  it('logs rejected and failed sends without throwing', async () => {
    const rejected = setup({}, () => Promise.resolve(new Response(null, { status: 429 })));
    rejected.reporter.capture(new Error('x'), { event: 'x' });
    await rejected.reporter.flush(1_000);
    expect(rejected.destination.lines().join('\n')).toMatch(
      /"event":"sentry_send_failed","status":429/,
    );
    const failed = setup({}, () => Promise.reject(new Error('ECONNREFUSED')));
    failed.reporter.capture(new Error('x'), { event: 'x' });
    expect(await failed.reporter.flush(1_000)).toBe(true);
    expect(failed.destination.lines().join('\n')).toMatch(
      /"event":"sentry_send_failed","status":null/,
    );
  });

  it('gives up flushing after the timeout', async () => {
    const { reporter } = setup({}, () => new Promise<Response>(() => undefined));
    reporter.capture(new Error('x'), { event: 'x' });
    expect(await reporter.flush(10)).toBe(false);
  });
});
