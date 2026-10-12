export interface GuardedHeaders {
  readonly origin?: string | undefined;
  readonly secFetchSite?: string | undefined;
  readonly client?: string | undefined;
}

export type OriginGuardFailure =
  'origin_missing' | 'origin_mismatch' | 'cross_site' | 'client_header';

/**
 * CSRF defence for every state-changing request (D8, 02 §5.5): the `Origin` header must
 * equal the relay's origin, `Sec-Fetch-Site` (when the browser sends it) must be
 * `same-origin`, and the PWA's `X-RC-Client: pwa` header must be present (it also forces
 * a CORS preflight that a foreign page cannot pass). `null` = allowed.
 */
export function checkOrigin(headers: GuardedHeaders, origin: string): OriginGuardFailure | null {
  if (headers.origin === undefined) return 'origin_missing';
  if (headers.origin !== origin) return 'origin_mismatch';
  if (headers.secFetchSite !== undefined && headers.secFetchSite !== 'same-origin') {
    return 'cross_site';
  }
  if (headers.client !== 'pwa') return 'client_header';
  return null;
}
