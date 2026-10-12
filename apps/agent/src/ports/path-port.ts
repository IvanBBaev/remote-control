/**
 * Path semantics of the host platform. Core code never imports `node:path`; it resolves
 * and compares paths only through this port (the allow-list check depends on it).
 */
export interface PathPort {
  /** True for an absolute path on this platform. */
  isAbsolute(path: string): boolean;
  /**
   * The canonical path (symlinks and `..` resolved by the file system), or `undefined`
   * when the path does not exist or cannot be resolved.
   */
  realpath(path: string): Promise<string | undefined>;
  /** True when `child` equals `parent` or lies inside it. Both must be canonical. */
  contains(parent: string, child: string): boolean;
  /** Joins path segments with the platform separator. */
  join(...segments: string[]): string;
}
