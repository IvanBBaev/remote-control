import { describe, expect, it } from 'vitest';

import { DIST_TAGS_URL, createNpmRegistry, type FetchFn } from './npm-registry.js';

function recorder(respond: () => Response | Promise<Response>): {
  fetchFn: FetchFn;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetchFn: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(respond());
    },
  };
}

describe('createNpmRegistry', () => {
  it('reads latest and the ETag from the dist-tags document', async () => {
    const { fetchFn, calls } = recorder(
      () =>
        new Response(JSON.stringify({ latest: '1.2.3', next: '2.0.0-rc.1' }), {
          headers: { etag: 'W/"abc"' },
        }),
    );
    expect(await createNpmRegistry(fetchFn).distTags()).toEqual({
      status: 'ok',
      latest: '1.2.3',
      etag: 'W/"abc"',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://registry.npmjs.org/-/package/remotectl/dist-tags');
    expect(calls[0]!.url).toBe(DIST_TAGS_URL);
    expect(calls[0]!.init.headers).toEqual({ accept: 'application/json' });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends If-None-Match and maps 304 to not-modified', async () => {
    const { fetchFn, calls } = recorder(() => new Response(null, { status: 304 }));
    expect(await createNpmRegistry(fetchFn).distTags('W/"abc"')).toEqual({
      status: 'not-modified',
    });
    expect(calls[0]!.init.headers).toEqual({
      accept: 'application/json',
      'if-none-match': 'W/"abc"',
    });
  });

  it('omits the ETag when the registry sends none', async () => {
    const { fetchFn } = recorder(() => new Response('{"latest":"1.0.0"}'));
    expect(await createNpmRegistry(fetchFn).distTags()).toEqual({ status: 'ok', latest: '1.0.0' });
  });

  it.each([
    ['a server error', () => new Response('oops', { status: 503 })],
    ['a non-JSON body', () => new Response('<html>')],
    ['a body without latest', () => new Response('{"next":"1.0.0"}')],
    ['a non-object body', () => new Response('null')],
    ['an empty latest', () => new Response('{"latest":""}')],
    [
      'a network error',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
  ])('maps %s to failed', async (_name, respond) => {
    const { fetchFn } = recorder(respond);
    expect(await createNpmRegistry(fetchFn).distTags()).toEqual({ status: 'failed' });
  });

  it('maps a rejected fetch (timeout) to failed', async () => {
    const registry = createNpmRegistry(() =>
      Promise.reject(new DOMException('timed out', 'TimeoutError')),
    );
    expect(await registry.distTags()).toEqual({ status: 'failed' });
  });
});
