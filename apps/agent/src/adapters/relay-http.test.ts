import { describe, expect, it } from 'vitest';

import type { FetchFn } from './npm-registry.js';
import { createRelayHttp } from './relay-http.js';

const SLOT = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const PHONE = '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f';

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch: FetchFn = (url, init) => {
    const call = { url, init };
    calls.push(call);
    return Promise.resolve(respond(call));
  };
  return { calls, fetch };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function api(respond: (call: Call) => Response | Promise<Response>) {
  const fake = fakeFetch(respond);
  return {
    calls: fake.calls,
    relay: createRelayHttp({ baseUrl: 'https://relay.test', token: 'tok', fetch: fake.fetch }),
  };
}

describe('createRelayHttp', () => {
  it('calls each route with the bearer token and parses the bodies', async () => {
    const { calls, relay } = api(({ url }) => {
      if (url.endsWith('/agents/token')) return json(200, { token: 'new' });
      if (url.endsWith('/pairings')) return json(201, { slotId: SLOT, expiresAt: 5 });
      if (url.endsWith('/complete')) return json(200, { pairingId: 'p', phoneDeviceId: PHONE });
      if (url.endsWith('/fail')) return json(200, { state: 'open', failedAttempts: 1 });
      return json(200, {
        slotId: SLOT,
        state: 'joined',
        phoneDeviceId: PHONE,
        failedAttempts: 0,
        expiresAt: 5,
      });
    });
    expect(await relay.rotateToken()).toEqual({ ok: true, value: { token: 'new' } });
    expect(await relay.openSlot('h')).toEqual({ ok: true, value: { slotId: SLOT, expiresAt: 5 } });
    expect(await relay.slotStatus(SLOT)).toMatchObject({ ok: true, value: { state: 'joined' } });
    expect(await relay.completeSlot(SLOT)).toEqual({
      ok: true,
      value: { pairingId: 'p', phoneDeviceId: PHONE },
    });
    expect(await relay.failSlot(SLOT)).toEqual({
      ok: true,
      value: { state: 'open', failedAttempts: 1 },
    });
    expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
      'POST https://relay.test/api/agents/token',
      'POST https://relay.test/api/pairings',
      `GET https://relay.test/api/pairings/${SLOT}`,
      `POST https://relay.test/api/pairings/${SLOT}/complete`,
      `POST https://relay.test/api/pairings/${SLOT}/fail`,
    ]);
    const [rotate, open] = calls;
    expect(rotate?.init.headers).toEqual({
      authorization: 'Bearer tok',
      accept: 'application/json',
    });
    expect(rotate?.init.body).toBeUndefined();
    expect(rotate?.init.redirect).toBe('error');
    expect(open?.init.body).toBe('{"codeHash":"h"}');
    expect(open?.init.headers).toMatchObject({ 'content-type': 'application/json' });
  });

  it('cancels a slot with an empty 204', async () => {
    const { calls, relay } = api(() => new Response(null, { status: 204 }));
    expect(await relay.cancelSlot(SLOT)).toEqual({ ok: true, value: null });
    expect(calls[0]?.init.method).toBe('DELETE');
  });

  it('reports the relay error code, a bad body and a network failure', async () => {
    expect(await api(() => json(409, { error: 'code_in_use' })).relay.openSlot('h')).toEqual({
      ok: false,
      status: 409,
      error: 'code_in_use',
    });
    expect(await api(() => new Response('oops', { status: 500 })).relay.openSlot('h')).toEqual({
      ok: false,
      status: 500,
      error: 'bad_response',
    });
    expect(await api(() => json(200, { slotId: 'x' })).relay.openSlot('h')).toEqual({
      ok: false,
      status: 200,
      error: 'bad_response',
    });
    expect(
      await api(() => Promise.reject(new TypeError('fetch failed'))).relay.rotateToken(),
    ).toEqual({ ok: false, status: 0, error: 'network' });
  });
});
