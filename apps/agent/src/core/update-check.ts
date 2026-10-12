// The notify-only update check (06 §5.3, Q7): pure decisions, no I/O.

/** How long a registry answer stays fresh. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The cached registry answer in `paths.cache/update-check.json`. */
export interface UpdateCache {
  /** Epoch ms of the last answered request (`ok` or `not-modified`). */
  readonly checkedAt: number;
  /** The `latest` dist-tag of that answer. */
  readonly latest: string;
  /** The registry's ETag, sent back as `If-None-Match`. */
  readonly etag?: string;
}

/** What a check concluded. `source` says whether the registry answered just now. */
export type UpdateCheckResult =
  | {
      readonly status: 'available' | 'current';
      readonly current: string;
      readonly latest: string;
      readonly source: 'registry' | 'cache';
    }
  | { readonly status: 'unknown'; readonly current: string }
  | { readonly status: 'disabled'; readonly current: string };

interface SemVer {
  readonly core: readonly [number, number, number];
  readonly prerelease: readonly string[];
}

const NUMERIC = /^(?:0|[1-9]\d*)$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseSemVer(version: string): SemVer | undefined {
  const match = SEMVER.exec(version);
  if (match === null) return undefined;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  if (!core.every((part) => Number.isSafeInteger(part))) return undefined;
  const prerelease = match[4]?.split('.') ?? [];
  // SemVer 2.0 §9: numeric identifiers must not have leading zeros.
  if (prerelease.some((id) => /^\d+$/.test(id) && !NUMERIC.test(id))) return undefined;
  return { core, prerelease };
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = NUMERIC.test(a);
  const bNumeric = NUMERIC.test(b);
  if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b));
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * SemVer 2.0 precedence of `a` against `b` (-1, 0, 1): a prerelease sorts below its
 * release, build metadata is ignored. `undefined` when either does not parse.
 */
export function compareVersions(a: string, b: string): number | undefined {
  const left = parseSemVer(a);
  const right = parseSemVer(b);
  if (left === undefined || right === undefined) return undefined;
  for (let i = 0; i < 3; i += 1) {
    const diff = Math.sign(left.core[i]! - right.core[i]!);
    if (diff !== 0) return diff;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return Math.sign(right.prerelease.length - left.prerelease.length);
  }
  const length = Math.min(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const diff = compareIdentifiers(left.prerelease[i]!, right.prerelease[i]!);
    if (diff !== 0) return diff;
  }
  return Math.sign(left.prerelease.length - right.prerelease.length);
}

/** True only when `latest` parses and is strictly newer than `current`. */
export function isNewer(latest: string, current: string): boolean {
  return (compareVersions(latest, current) ?? 0) > 0;
}

/** True while the cached answer is younger than 24 h (a clock jump back counts as stale). */
export function cacheIsFresh(cache: UpdateCache | undefined, now: number): boolean {
  if (cache === undefined) return false;
  const age = now - cache.checkedAt;
  return age >= 0 && age < UPDATE_CHECK_INTERVAL_MS;
}

/** The cache file's contents, or `undefined` when missing or corrupt (treated as absent). */
export function parseUpdateCache(text: string | undefined): UpdateCache | undefined {
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { checkedAt, latest, etag } = value as Record<string, unknown>;
  if (typeof checkedAt !== 'number' || !Number.isFinite(checkedAt)) return undefined;
  if (typeof latest !== 'string' || latest === '') return undefined;
  if (etag !== undefined && typeof etag !== 'string') return undefined;
  return etag === undefined ? { checkedAt, latest } : { checkedAt, latest, etag };
}

/** The cache file's text. */
export function serializeUpdateCache(cache: UpdateCache): string {
  return `${JSON.stringify(cache)}\n`;
}

/** The verdict for `latest` against the running `current` version. */
export function verdict(
  current: string,
  latest: string,
  source: 'registry' | 'cache',
): UpdateCheckResult {
  return { status: isNewer(latest, current) ? 'available' : 'current', current, latest, source };
}
