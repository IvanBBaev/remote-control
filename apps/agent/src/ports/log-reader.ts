/** Read access to the agent's own rolling log files (for `remotectl logs`). */
export interface LogReader {
  /** The newest log file, or `undefined` before the agent has logged anything. */
  newest(): Promise<string | undefined>;
  /** Current size in bytes; 0 when the file is gone. */
  size(path: string): Promise<number>;
  /** Reads the bytes `[start, end)` as UTF-8. */
  read(path: string, start: number, end: number): Promise<string>;
}
