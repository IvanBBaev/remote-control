import { request } from 'node:http';
import { createServer, type Server } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { seededRandom } from '@remote-control/fake-claude-code';
import { afterEach, describe, expect, it } from 'vitest';

import { createHookDispatcher, type HookHandler } from '../core/hook-dispatcher.js';
import { createPendingStore, type PendingStore } from '../core/pending-store.js';
import { systemClock } from './system-clock.js';
import { systemTimer } from './system-timer.js';
import {
  HOOK_AGENT_HEADER,
  HOOK_TIMEOUT_HEADER,
  HookReceiverBindError,
  startHookReceiver,
  type HookReceiver,
} from './hook-receiver.js';

const TOKEN = 'test-token-0123456789';

interface Answer {
  readonly status: number;
  readonly body: string;
}

function post(
  port: number,
  body: string,
  headers: Record<string, string> = {},
  options: { path?: string; method?: string; signal?: AbortSignal } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: options.path ?? '/hook',
        method: options.method ?? 'POST',
        ...(options.signal ? { signal: options.signal } : {}),
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const permission = JSON.stringify({
  hook_event_name: 'PermissionRequest',
  session_id: 's1',
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
});

describe('HookReceiver', () => {
  let receiver: HookReceiver | undefined;
  let store: PendingStore;
  let seenTimeouts: number[];

  async function start(handler?: HookHandler): Promise<HookReceiver> {
    store = createPendingStore({ clock: systemClock, timer: systemTimer, random: seededRandom() });
    seenTimeouts = [];
    const dispatcher = createHookDispatcher({ store });
    receiver = await startHookReceiver({
      port: 0,
      token: TOKEN,
      defaultHookTimeoutMs: 1_800_000,
      handler:
        handler ??
        ((input, context) => {
          seenTimeouts.push(context.hookTimeoutMs);
          return dispatcher(input, context);
        }),
    });
    return receiver;
  }

  afterEach(async () => {
    store?.releaseAll('shutdown');
    await receiver?.close();
    receiver = undefined;
  });

  it('binds to loopback on a free port', async () => {
    const { port } = await start();
    expect(port).toBeGreaterThan(0);
  });

  it('answers a feed event with 204 and no body', async () => {
    const { port } = await start();
    const answer = await post(port, JSON.stringify({ hook_event_name: 'Stop', session_id: 's' }));
    expect(answer).toEqual({ status: 204, body: '' });
  });

  it('holds a permission request 5 s, then answers with the allow decision', async () => {
    const { port } = await start();
    const started = performance.now();
    const answer = post(port, permission);
    const allow = {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    };
    setTimeout(() => {
      const [pending] = store.list();
      store.resolve(pending!.id, allow);
    }, 5_000);
    const result = await answer;
    expect(performance.now() - started).toBeGreaterThanOrEqual(4_900);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual(allow);
  }, 15_000);

  it('answers {} when the request expires (T - 10 s)', async () => {
    const { port } = await start();
    const answer = await post(port, permission, { [HOOK_TIMEOUT_HEADER]: '10.2' });
    expect(answer).toEqual({ status: 200, body: '{}' });
    expect(seenTimeouts).toEqual([10_200]);
  });

  it('falls back to the default timeout for a missing or bad header', async () => {
    const { port } = await start();
    for (const value of [undefined, 'abc', '0', '90000']) {
      const headers: Record<string, string> =
        value === undefined ? {} : { [HOOK_TIMEOUT_HEADER]: value };
      const pending = post(port, permission, headers);
      await waitUntil(() => store.list().length === 1);
      store.releaseAll('released');
      expect(await pending).toEqual({ status: 200, body: '{}' });
    }
    expect(seenTimeouts).toEqual([1_800_000, 1_800_000, 1_800_000, 1_800_000]);
  });

  it('hands off the request when the hook disconnects', async () => {
    const { port } = await start();
    const controller = new AbortController();
    const pending = post(port, permission, {}, { signal: controller.signal });
    await waitUntil(() => store.list().length === 1);
    controller.abort();
    await expect(pending).rejects.toThrow();
    await waitUntil(() => store.list().length === 0);
  });

  it('rejects a wrong or missing token with 401', async () => {
    const { port } = await start();
    expect((await post(port, permission, { authorization: 'Bearer nope' })).status).toBe(401);
    expect((await post(port, permission, { authorization: `Basic ${TOKEN}` })).status).toBe(401);
    expect(store.list()).toEqual([]);
  });

  it('rejects any browser Origin and a foreign Host with 403', async () => {
    const { port } = await start();
    const origin = await post(port, permission, { origin: 'http://127.0.0.1' });
    expect(origin).toEqual({ status: 403, body: '{"error":"origin_rejected"}' });
    const host = await post(port, permission, { host: `evil.example:${port}` });
    expect(host).toEqual({ status: 403, body: '{"error":"host_rejected"}' });
    const otherPort = await post(port, permission, { host: `127.0.0.1:${port + 1}` });
    expect(otherPort.status).toBe(403);
    const localhost = await post(
      port,
      JSON.stringify({ hook_event_name: 'Stop', session_id: 's' }),
      {
        host: `localhost:${port}`,
      },
    );
    expect(localhost.status).toBe(204);
  });

  it('answers the authenticated health probe with 204', async () => {
    const { port } = await start();
    const get = { method: 'GET', path: '/health' };
    expect(await post(port, '', {}, get)).toEqual({ status: 204, body: '' });
    expect((await post(port, '', { authorization: 'Bearer nope' }, get)).status).toBe(401);
    expect((await post(port, '', { origin: 'http://127.0.0.1' }, get)).status).toBe(403);
  });

  it('passes the agent header to the handler, claude-code when absent (M2-01)', async () => {
    const agents: (string | undefined)[] = [];
    const { port } = await start((_input, context) => {
      agents.push(context.agent);
      return Promise.resolve({ status: 204 });
    });
    const stop = JSON.stringify({ hook_event_name: 'Stop', session_id: 's' });
    expect((await post(port, stop, { [HOOK_AGENT_HEADER]: 'codex' })).status).toBe(204);
    expect((await post(port, stop)).status).toBe(204);
    expect((await post(port, stop, { [HOOK_AGENT_HEADER]: 'cursor' })).status).toBe(400);
    expect(agents).toEqual(['codex', 'claude-code']);
  });

  it('rejects malformed input with 400 and has no other route', async () => {
    const { port } = await start();
    expect((await post(port, JSON.stringify({ session_id: 's' }))).status).toBe(400);
    expect((await post(port, '[]')).status).toBe(400);
    expect((await post(port, '{}', {}, { path: '/decide' })).status).toBe(404);
    expect((await post(port, '', {}, { method: 'GET' })).status).toBe(404);
  });

  it('throws HookReceiverBindError when the port is taken', async () => {
    const blocker: Server = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      await expect(
        startHookReceiver({
          port,
          token: TOKEN,
          defaultHookTimeoutMs: 1_000,
          handler: () => Promise.resolve({ status: 204 }),
        }),
      ).rejects.toThrow(HookReceiverBindError);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await delay(10);
  expect(condition()).toBe(true);
}
