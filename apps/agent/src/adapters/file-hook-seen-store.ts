import { z } from 'zod';

import type { FileSystem } from '../ports/file-system.js';
import type { HookSeenStore } from '../ports/hook-seen-store.js';
import type { PathPort } from '../ports/path-port.js';
import { SECRET_DIR_MODE, SECRET_FILE_MODE } from './file-key-store.js';

export const HOOK_SEEN_FILE = 'hooks-seen.json';
/** The Codex canary (M2-01): keyed by hook event, a `SessionStart` proves `/hooks` trust. */
export const CODEX_HOOK_SEEN_FILE = 'codex-hooks-seen.json';

const HookSeenFile = z.object({
  version: z.literal(1),
  roots: z.record(z.string().min(1), z.int().nonnegative()),
});

export interface FileHookSeenStoreOptions {
  /** The env-paths `data` directory. */
  readonly dir: string;
  readonly fs: FileSystem;
  readonly paths: PathPort;
  /** The file name in `dir`; default `hooks-seen.json`. */
  readonly file?: string;
}

/**
 * `hooks-seen.json` (or `options.file`) in the data directory: 0600 in a 0700 directory,
 * written atomically.
 */
export function createFileHookSeenStore(options: FileHookSeenStoreOptions): HookSeenStore {
  const { dir, fs } = options;
  const path = options.paths.join(dir, options.file ?? HOOK_SEEN_FILE);
  let writes = Promise.resolve();

  async function read(): Promise<Record<string, number>> {
    try {
      const text = await fs.readText(path);
      if (text === undefined) return {};
      const parsed = HookSeenFile.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data.roots : {};
    } catch {
      return {};
    }
  }

  return {
    read,
    record(root, at) {
      // One write at a time: a burst of first hooks never loses a root.
      const write = writes.then(async () => {
        const roots = await read();
        if (Object.hasOwn(roots, root)) return;
        roots[root] = at;
        await fs.ensureDir(dir, SECRET_DIR_MODE);
        const text = `${JSON.stringify({ version: 1, roots }, null, 2)}\n`;
        await fs.writeTextAtomic(path, text, SECRET_FILE_MODE);
      });
      writes = write.catch(() => undefined);
      return write;
    },
  };
}
