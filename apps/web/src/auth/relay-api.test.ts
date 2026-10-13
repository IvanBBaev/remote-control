import { describe, expect, it, vi } from 'vitest';

import { OfflineError, RelayError, createRelayApi } from './relay-api.js';
import type { FetchLike } from './relay-api.js';

function respond(status: number, body?: unknown, headers: Record<string, string> = {}) {
  return vi.fn<FetchLike>(() =>
    Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), { status, headers }),
    ),
  );
}

describe('createRelayApi', () => {
  it('posts JSON with the PWA client header and the same-origin cookie', async () => {
    const fetchImpl = respond(200, { challenge: 'abc' });
    const api = createRelayApi(fetchImpl, { baseUrl: 'https://relay.test' });
    await expect(api.registerOptions({ inviteCode: 'INV' })).resolves.toEqual({
      challenge: 'abc',
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://relay.test/api/auth/register/options');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'x-rc-client': 'pwa', 'content-type': 'application/json' },
      body: '{"inviteCode":"INV"}',
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends no body and no content type on a call without input', async () => {
    const fetchImpl = respond(200, { challenge: 'abc' });
    await createRelayApi(fetchImpl).loginOptions();
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.headers).toEqual({ 'x-rc-client': 'pwa' });
    expect(init).not.toHaveProperty('body');
  });

  it.each([
    ['registerVerify', '/api/auth/register/verify'],
    ['loginVerify', '/api/auth/login/verify'],
  ] as const)('%s posts the credential response to %s', async (method, path) => {
    const fetchImpl = respond(200, { userId: 'u' });
    const api = createRelayApi(fetchImpl);
    await api[method]({ id: 'x' } as never);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(path);
    expect(fetchImpl.mock.calls[0]?.[1].body).toBe('{"id":"x"}');
  });

  it('wraps decision calls in the relay request shapes', async () => {
    const fetchImpl = respond(200, { ok: true });
    const api = createRelayApi(fetchImpl);
    await api.decisionChallenge('ab'.repeat(32));
    await api.decisionVerify({ id: 'x' } as never);
    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init.body])).toEqual([
      ['/api/decisions/challenge', JSON.stringify({ decisionHash: 'ab'.repeat(32) })],
      ['/api/decisions/verify', '{"response":{"id":"x"}}'],
    ]);
  });

  it('reads the session, and a 401 as signed out', async () => {
    await expect(createRelayApi(respond(200, { userId: 'u' })).session()).resolves.toEqual({
      userId: 'u',
    });
    await expect(
      createRelayApi(respond(401, { error: 'unauthenticated' })).session(),
    ).resolves.toBeNull();
    await expect(createRelayApi(respond(500, { error: 'boom' })).session()).rejects.toThrow(
      RelayError,
    );
  });

  it('logs out without reading a body', async () => {
    const fetchImpl = respond(204);
    await expect(createRelayApi(fetchImpl).logout()).resolves.toBeUndefined();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/auth/logout');
  });

  it('turns a failed fetch into OfflineError', async () => {
    const cause = new TypeError('Failed to fetch');
    const api = createRelayApi(() => Promise.reject(cause));
    const error: unknown = await api.loginOptions().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OfflineError);
    expect((error as OfflineError).cause).toBe(cause);
  });

  it('turns an error status into RelayError with its reason and retry-after', async () => {
    const limited = createRelayApi(
      respond(429, { error: 'rate_limited' }, { 'retry-after': '30' }),
    );
    await expect(limited.loginOptions()).rejects.toMatchObject({
      status: 429,
      reason: 'rate_limited',
      retryAfterSec: 30,
    });
    const invalid = createRelayApi(respond(403, { error: 'invalid_invite' }));
    await expect(invalid.registerOptions({ inviteCode: 'x' })).rejects.toMatchObject({
      status: 403,
      reason: 'invalid_invite',
      retryAfterSec: undefined,
    });
  });

  it.each([
    ['no body', undefined],
    ['a non-string error', { error: 42 }],
  ])('reads %s as reason "unknown"', async (_label, body) => {
    const api = createRelayApi(respond(502, body));
    await expect(api.loginOptions()).rejects.toMatchObject({ status: 502, reason: 'unknown' });
  });
});
