/** File access used by the stores. The Node adapter is `adapters/node-file-system.ts`. */
export interface FileSystem {
  /** File contents as UTF-8, or `undefined` when the file does not exist. */
  readText(path: string): Promise<string | undefined>;
  /**
   * Writes `text` atomically: a sibling temp file created with `mode`, then renamed over
   * `path`, so a reader never sees a partial file and the mode is never wider in between.
   */
  writeTextAtomic(path: string, text: string, mode: number): Promise<void>;
  /** Creates the directory (and its parents) if missing, with `mode` for new ones. */
  ensureDir(path: string, mode: number): Promise<void>;
  /** POSIX permission bits (`0o777` mask), or `undefined` when the file does not exist. */
  permissions(path: string): Promise<number | undefined>;
  /** Sets the POSIX permission bits. */
  chmod(path: string, mode: number): Promise<void>;
  /** Deletes a file; resolves `true` when it existed, `false` when it did not. */
  remove(path: string): Promise<boolean>;
}
