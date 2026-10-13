import { emptyStats, parseStats, recordStats } from '../core/usage-stats.js';
import type { StatDelta, StatsFile } from '../core/usage-stats.js';
import type { Clock } from '../ports/clock.js';
import type { FileSystem } from '../ports/file-system.js';
import type { PathPort } from '../ports/path-port.js';
import { SECRET_DIR_MODE, SECRET_FILE_MODE } from './file-key-store.js';

export const STATS_FILE = 'stats.json';

/** The local usage counters (M1-11, M2-06). */
export interface StatsStore {
  /** The counters; an unreadable or missing file reads as empty. */
  read(): Promise<StatsFile>;
  /**
   * Adds `delta` to `project`, active now. Never rejects: a counter that cannot be written
   * is reported through `onWarning` and must not disturb a hook (I2).
   */
  record(project: string | undefined, delta: StatDelta): Promise<void>;
}

export interface FileStatsStoreOptions {
  /** The env-paths `data` directory. */
  readonly dir: string;
  readonly fs: FileSystem;
  readonly paths: PathPort;
  readonly clock: Clock;
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

  async function write(project: string | undefined, delta: StatDelta): Promise<void> {
    const next = recordStats(await read(), project, delta, options.clock.now());
    await fs.ensureDir(dir, SECRET_DIR_MODE);
    await fs.writeTextAtomic(path, `${JSON.stringify(next, null, 2)}\n`, SECRET_FILE_MODE);
  }

  return {
    read,
    record(project, delta) {
      const run = queue.then(() => write(project, delta));
      queue = run.catch((error: unknown) => {
        options.onWarning?.(
          `could not update ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      return queue;
    },
  };
}
