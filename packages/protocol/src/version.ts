/**
 * Protocol version table (D14). `v` is stamped on every frame; the relay supports the
 * current and the previous major, so `MIN_SUPPORTED_VERSION` trails `PROTOCOL_VERSION`
 * by at most one. Inside a major, changes are additive only.
 */
export const VERSION_TABLE = {
  /** Protocol id used in docs and the agent's `--version` output. */
  id: 'rc/v1',
  /** The version this build speaks and stamps on every frame. */
  v: 1,
  /** The oldest version this build still accepts (current or previous major). */
  min_supported: 1,
} as const;
