import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_HOOK_TIMEOUT_SECONDS,
  MAX_RESPONSE_BYTES,
  hookBudgetMs,
  hookTimeoutSeconds,
  runHook,
  type HookDeps,
} from './run-hook.js';

const INPUT = JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 's1' });

interface Seen {
  readonly headers: IncomingMessage['headers'];
  readonly url: string | undefined;
  readonly body: string;
}

/** A stand-in for the agent's receiver. */
async function fakeReceiver(
  respond: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<{ server: Server; port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      seen.push({ headers: req.headers, url: req.url, body });
      respond(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port, seen };
}

function deps(endpoint: string | (() => Promise<string>), argv: readonly string[] = ['600']) {
  let stdout = '';
  const value: HookDeps = {
    argv,
    readStdin: () => Promise.resolve(INPUT),
    readEndpoint: typeof endpoint === 'string' ? () => Promise.resolve(endpoint) : endpoint,
    write: (text) => {
      stdout += text;
      return Promise.resolve();
    },
  };
  return { deps: value, stdout: () => stdout };
}

const endpointFor = (port: number, token = 'tok'): string =>
  JSON.stringify({ version: 1, port, token, generation: 1 });

describe('hookTimeoutSeconds / hookBudgetMs', () => {
  it('reads T from argv and falls back to the default', () => {
    expect(hookTimeoutSeconds(['1800'])).toBe(1800);
    expect(hookTimeoutSeconds(['0.5'])).toBe(0.5);
    for (const argv of [[], ['x'], ['0'], ['999999'], ['-1']]) {
      expect(hookTimeoutSeconds(argv)).toBe(DEFAULT_HOOK_TIMEOUT_SECONDS);
    }
  });

  it('gives up 5 s before T, or at half of a short T', () => {
    expect(hookBudgetMs(1800)).toBe(1_795_000);
    expect(hookBudgetMs(5)).toBe(2_500);
  });
});

describe('runHook', () => {
  let server: Server | undefined;

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it('posts the input with the token and prints the agent JSON verbatim', async () => {
    const body = '{ "hookSpecificOutput" : {"decision":{"behavior":"allow"}} }';
    const fake = await fakeReceiver((_req, res) => res.writeHead(200).end(body));
    server = fake.server;
    const run = deps(endpointFor(fake.port), ['1800']);
    await runHook(run.deps);
    expect(run.stdout()).toBe(body);
    expect(fake.seen).toHaveLength(1);
    expect(fake.seen[0]).toMatchObject({
      url: '/hook',
      body: INPUT,
      headers: {
        authorization: 'Bearer tok',
        'content-type': 'application/json',
        'x-remotectl-hook-timeout': '1800',
        host: `127.0.0.1:${fake.port}`,
      },
    });
  });

  it('prints nothing when the agent is down', async () => {
    const fake = await fakeReceiver(() => undefined);
    const { port } = fake;
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    const run = deps(endpointFor(port));
    await runHook(run.deps);
    expect(run.stdout()).toBe('');
  });

  it('prints nothing on 401', async () => {
    const fake = await fakeReceiver((_req, res) =>
      res.writeHead(401).end('{"error":"unauthorized"}'),
    );
    server = fake.server;
    const run = deps(endpointFor(fake.port, 'wrong'));
    await runHook(run.deps);
    expect(run.stdout()).toBe('');
  });

  it('prints nothing on 204 and on a non-object answer', async () => {
    for (const [status, body] of [
      [204, ''],
      [200, 'not json'],
      [200, '[1]'],
      [200, 'null'],
    ] as const) {
      const fake = await fakeReceiver((_req, res) => res.writeHead(status).end(body));
      const run = deps(endpointFor(fake.port));
      await runHook(run.deps);
      expect(run.stdout()).toBe('');
      fake.server.close();
    }
  });

  it('prints nothing for an oversized answer', async () => {
    const fake = await fakeReceiver((_req, res) => {
      res.writeHead(200);
      res.end(`{"x":"${'a'.repeat(MAX_RESPONSE_BYTES)}"}`);
    });
    server = fake.server;
    const run = deps(endpointFor(fake.port));
    await runHook(run.deps);
    expect(run.stdout()).toBe('');
  });

  it('gives up at its own deadline and prints nothing', async () => {
    const fake = await fakeReceiver(() => undefined); // never answers
    server = fake.server;
    const run = deps(endpointFor(fake.port), ['0.4']);
    const started = performance.now();
    await runHook(run.deps);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(2_000);
    expect(run.stdout()).toBe('');
  });

  it('prints nothing without a usable agent.json', async () => {
    for (const endpoint of [
      () => Promise.reject(new Error('ENOENT')),
      () => Promise.resolve('not json'),
      () => Promise.resolve('null'),
      () => Promise.resolve('{"port":0,"token":"t"}'),
      () => Promise.resolve('{"port":4327,"token":""}'),
    ]) {
      const run = deps(endpoint);
      await runHook(run.deps);
      expect(run.stdout()).toBe('');
    }
  });

  it('survives a failing stdout', async () => {
    const fake = await fakeReceiver((_req, res) => res.writeHead(200).end('{}'));
    server = fake.server;
    const run = deps(endpointFor(fake.port));
    await expect(
      runHook({ ...run.deps, write: () => Promise.reject(new Error('EPIPE')) }),
    ).resolves.toBeUndefined();
  });
});
