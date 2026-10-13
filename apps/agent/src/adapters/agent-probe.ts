import type { KeyStore } from '../ports/key-store.js';
import { HOOK_HOST } from './hook-receiver.js';
import type { FetchFn } from './npm-registry.js';

const PROBE_TIMEOUT_MS = 2_000;

/**
 * Whether a `remotectl run` answers on the hook endpoint it published (`agent.json`):
 * the authenticated `GET /health` of the loopback receiver (M1-07). A stale endpoint
 * file, a refused connection or a wrong token all read as not running.
 */
export function createAgentProbe(options: {
  readonly keyStore: KeyStore;
  readonly fetch: FetchFn;
}): () => Promise<boolean> {
  return async () => {
    const endpoint = await options.keyStore.readHookEndpoint().catch(() => undefined);
    if (endpoint === undefined) return false;
    try {
      const response = await options.fetch(`http://${HOOK_HOST}:${endpoint.port}/health`, {
        method: 'GET',
        headers: { authorization: `Bearer ${endpoint.token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return response.status === 204;
    } catch {
      return false;
    }
  };
}
