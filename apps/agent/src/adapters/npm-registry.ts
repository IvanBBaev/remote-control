import type { DistTagsResult, Registry } from '../ports/registry.js';

/** The dist-tags document of the published package (06 §5.3). */
export const DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/remotectl/dist-tags';
const TIMEOUT_MS = 5000;

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/**
 * `Registry` over `fetch`. Besides the relay connection this is the agent's only network
 * call: one small GET of the dist-tags, conditional on the cached ETag, with a 5 s
 * timeout. Nothing is ever downloaded or installed; every error (offline, timeout, a
 * non-2xx status, a body without a string `latest`) becomes `failed`.
 */
export function createNpmRegistry(fetchFn: FetchFn = (url, init) => fetch(url, init)): Registry {
  return {
    async distTags(etag): Promise<DistTagsResult> {
      try {
        const headers: Record<string, string> = { accept: 'application/json' };
        if (etag !== undefined) headers['if-none-match'] = etag;
        const response = await fetchFn(DIST_TAGS_URL, {
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (response.status === 304) return { status: 'not-modified' };
        if (!response.ok) return { status: 'failed' };
        const body: unknown = await response.json();
        const latest =
          typeof body === 'object' && body !== null
            ? (body as Record<string, unknown>)['latest']
            : undefined;
        if (typeof latest !== 'string' || latest === '') return { status: 'failed' };
        const newEtag = response.headers.get('etag') ?? undefined;
        return newEtag === undefined
          ? { status: 'ok', latest }
          : { status: 'ok', latest, etag: newEtag };
      } catch {
        return { status: 'failed' };
      }
    },
  };
}
