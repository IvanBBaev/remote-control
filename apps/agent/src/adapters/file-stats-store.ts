import { emptyStats, parseStats, recordStat } from '../core/usage-stats.js';
import type { StatField, StatsFile } from '../core/usage-stats.js';
import type { FileSystem } from '../ports/file-system.js';
import type { PathPort } from '../ports/path-port.js';
import { SECRET_DIR_MODE, SECRET_FILE_MODE } from './file-key-store.js';

export const STATS_FILE = 'stats.json';

/** The local usage counters (M1-11). */
export interface StatsStore {
  /** The counters; an unreadable or missing file reads as empty. */
  read(): Promise<StatsFile>;
  /**
   * Counts one `field` for `project`. Never rejects: a counter that cannot be written is
   * reported through `onWarning` and must not disturb a hook (I2).
   */
  record(project: string | undefined, field: StatField): Promise<void>;
}

export interface FileStatsStoreOptions {
  /** The env-paths `data` directory. */
  readonly dir: string;
  readonly fs: FileSystem;
  readonly paths: PathPort;
  readonly onWarning?: (message: string) => void;
}

/**
 * `stats.json` in the data directory: 0600 in a 0700 directory, written atomically (D22).
 * Writes are serialised, so concurrent hooks never lose a count.
 */
export function createFileStatsStore(options: FileStatsStoreOptions): StatsStore {
  const { dir, fs } = options;
  const path = options.paths.join(dir, STATS_FILE);
  let queue: Promise<void> = Promise.resolve();

  async function read(): Promise<StatsFile> {
    const text = await fs.readText(path);
    return (text === undefined ? undefined : parseStats(text)) ?? emptyStats();
  }

  async function write(project: string | undefined, field: StatField): Promise<void> {
    const next = recordStat(await read(), project, field);
    await fs.ensureDir(dir, SECRET_DIR_MODE);
    await fs.writeTextAtomic(path, `${JSON.stringify(next, null, 2)}\n`, SECRET_FILE_MODE);
  }

  return {
    read,
    record(project, field) {
      const run = queue.then(() => write(project, field));
      queue = run.catch((error: unknown) => {
        options.onWarning?.(
          `could not update ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      return queue;
    },
  };
}
