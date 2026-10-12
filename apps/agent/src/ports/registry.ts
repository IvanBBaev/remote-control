/** The answer of one dist-tags request; every error is `failed` (06 §5.3). */
export type DistTagsResult =
  | { readonly status: 'ok'; readonly latest: string; readonly etag?: string }
  | { readonly status: 'not-modified' }
  | { readonly status: 'failed' };

/**
 * The npm registry, read for the notify-only update check (06 §5.3, Q7). The real
 * adapter is `adapters/npm-registry.ts`; tests inject a fake. Nothing is ever downloaded.
 */
export interface Registry {
  /** `GET …/-/package/remotectl/dist-tags`, conditional on `etag` when given. */
  distTags(etag?: string): Promise<DistTagsResult>;
}
