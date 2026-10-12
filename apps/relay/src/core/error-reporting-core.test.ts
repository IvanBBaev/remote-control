import { describe, expect, it } from 'vitest';

import { buildErrorEvent } from './error-event.js';
import { scrubMessage } from './scrub-message.js';
import { parseSentryDsn } from './sentry-dsn.js';

const META = {
  eventId: '0'.repeat(32),
  timestampMs: 1_700_000_000_500,
  release: 'abc123',
  environment: 'production',
};

describe('scrubMessage', () => {
  it('replaces URLs, e-mail addresses, quoted payloads and token-like runs', () => {
    expect(scrubMessage('fetch https://push.example.com/abc?x=1 failed')).toBe(
      'fetch [url] failed',
    );
    expect(scrubMessage('no account for ivan@example.com')).toBe('no account for [email]');
    expect(scrubMessage(`Unexpected token 's', "secret value" is not valid JSON`)).toBe(
      `Unexpected token 's', "[redacted]" is not valid JSON`,
    );
    expect(scrubMessage('bad input "{"secret": "value"}" here')).toBe(
      'bad input "[redacted]" here',
    );
    expect(scrubMessage(`bad token ${'A'.repeat(43)} given`)).toBe('bad token [redacted] given');
    expect(scrubMessage('Unexpected token } in JSON at position 4')).toBe(
      'Unexpected token } in JSON at position 4',
    );
  });

  it('caps the length at 300 characters', () => {
    expect(scrubMessage('word '.repeat(200))).toHaveLength(300);
  });
});

describe('parseSentryDsn', () => {
  it('derives the envelope URL and public key', () => {
    expect(parseSentryDsn('https://k3y@o1.ingest.sentry.io/42')).toEqual({
      dsn: 'https://k3y@o1.ingest.sentry.io/42',
      publicKey: 'k3y',
      envelopeUrl: 'https://o1.ingest.sentry.io/api/42/envelope/',
    });
    expect(parseSentryDsn('https://k@sentry.example.com/sub/7/')?.envelopeUrl).toBe(
      'https://sentry.example.com/sub/api/7/envelope/',
    );
  });

  it('rejects anything that is not an https DSN with a key and numeric project', () => {
    for (const dsn of [
      'not a url',
      'http://k@o1.ingest.sentry.io/42',
      'https://o1.ingest.sentry.io/42',
      'https://k:secret@o1.ingest.sentry.io/42',
      'https://k@o1.ingest.sentry.io/project',
    ]) {
      expect(parseSentryDsn(dsn), dsn).toBeNull();
    }
  });
});

describe('buildErrorEvent', () => {
  it('keeps only the allow-listed fields, causes first and frames oldest first', () => {
    const error = new Error('outer', { cause: new TypeError('inner') });
    const event = buildErrorEvent(
      error,
      { event: 'http_error', reqId: 'req-1', method: 'POST', route: '/api/x/:id' },
      META,
    );
    expect(Object.keys(event).sort()).toEqual(
      [
        'environment',
        'event_id',
        'exception',
        'level',
        'logger',
        'platform',
        'release',
        'tags',
        'timestamp',
      ].sort(),
    );
    expect(event).toMatchObject({
      timestamp: 1_700_000_000.5,
      level: 'error',
      tags: { event: 'http_error', req_id: 'req-1', method: 'POST', route: '/api/x/:id' },
    });
    expect(event.exception.values.map((v) => [v.type, v.value])).toEqual([
      ['TypeError', 'inner'],
      ['Error', 'outer'],
    ]);
    const frames = event.exception.values[1]?.stacktrace?.frames ?? [];
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.at(-1)?.filename).toMatch(/error-reporting-core\.test\.ts$/);
    expect(frames.at(-1)?.in_app).toBe(true);
  });

  it('marks crashes fatal, drops suspicious tags and names, and hides non-Error values', () => {
    const odd = new Error('x');
    odd.name = 'name with "payload"';
    const event = buildErrorEvent(
      odd,
      { event: 'uncaught_exception', reqId: 'has space', route: 'a'.repeat(101) },
      { ...META, release: undefined },
    );
    expect(event.level).toBe('fatal');
    expect(event.tags).toEqual({ event: 'uncaught_exception' });
    expect(event.exception.values[0]?.type).toBe('Error');
    expect('release' in event).toBe(false);
    const thrown = buildErrorEvent({ secret: 'payload' }, { event: 'x' }, META);
    expect(thrown.exception.values).toEqual([{ type: 'NonError', value: 'thrown object' }]);
    expect(JSON.stringify(thrown)).not.toContain('payload');
  });

  it('parses V8 frames, strips file URLs and flags library frames', () => {
    const error = new Error('x');
    error.stack = [
      'Error: x',
      '    at handler (file:///app/dist/server.js:10:5)',
      '    at /app/node_modules/fastify/lib/route.js:1:2',
      '    at node:internal/process/task_queues:95:5',
    ].join('\n');
    const frames = buildErrorEvent(error, { event: 'x' }, META).exception.values[0]?.stacktrace
      ?.frames;
    expect(frames).toEqual([
      { filename: 'node:internal/process/task_queues', lineno: 95, colno: 5, in_app: false },
      { filename: '/app/node_modules/fastify/lib/route.js', lineno: 1, colno: 2, in_app: false },
      { function: 'handler', filename: '/app/dist/server.js', lineno: 10, colno: 5, in_app: true },
    ]);
  });
});
