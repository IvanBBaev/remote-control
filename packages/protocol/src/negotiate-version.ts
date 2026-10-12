import { VERSION_TABLE } from './version.js';

/** An inclusive range of protocol versions a peer can speak. */
export interface VersionRange {
  readonly min: number;
  readonly max: number;
}

const LOCAL_RANGE: VersionRange = { min: VERSION_TABLE.min_supported, max: VERSION_TABLE.v };

/**
 * Picks the highest version both sides support, or `null` when the ranges do not
 * overlap (the relay then closes with `unsupported_version`, 03 §5.10).
 */
export function negotiateVersion(
  peer: VersionRange,
  local: VersionRange = LOCAL_RANGE,
): number | null {
  const highest = Math.min(peer.max, local.max);
  const lowest = Math.max(peer.min, local.min);
  return highest >= lowest ? highest : null;
}
