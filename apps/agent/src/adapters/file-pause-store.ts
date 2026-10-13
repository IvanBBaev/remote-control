import { parsePause, type PauseFile } from '../core/pause-state.js';
import type { FileSystem } from '../ports/file-system.js';
import type { PathPort } from '../ports/path-port.js';
import { SECRET_DIR_MODE, SECRET_FILE_MODE } from './file-key-store.js';

export const PAUSE_FILE = 'pause.json';

/** The `remotectl pause` switch (M1-03), shared by the CLI and the running agent. */
export interface PauseStore {
  /** The pause file; a missing or unreadable one reads as `undefined` (not paused). */
  read(): Promise<PauseFile | undefined>;
  /** Writes the pause file. */
  write(state: PauseFile): Promise<void>;
  /** Removes the pause file; resolves `true` when there was one. */
  clear(): Promise<boolean>;
}

export interface FilePauseStoreOptions {
  /** The env-paths `data` directory. */
  readonly dir: string;
  readonly fs: FileSystem;
  readonly paths: PathPort;
}

/**
 * `pause.json` in the data directory: 0600 in a 0700 directory, written atomically, so
 * the running agent (which reads it per blocking hook) never sees a partial file.
 */
export function createFilePauseStore(options: FilePauseStoreOptions): PauseStore {
  const { dir, fs } = options;
  const path = options.paths.join(dir, PAUSE_FILE);
  return {
    async read() {
      try {
        const text = await fs.readText(path);
        return text === undefined ? undefined : parsePause(text);
      } catch {
        return undefined;
      }
    },
    async write(state) {
      await fs.ensureDir(dir, SECRET_DIR_MODE);
      await fs.writeTextAtomic(path, `${JSON.stringify(state, null, 2)}\n`, SECRET_FILE_MODE);
    },
    clear() {
      return fs.remove(path);
    },
  };
}
