import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import { toHex } from '@remote-control/protocol';

import type { FileSystem } from '../ports/file-system.js';
import type { PathPort } from '../ports/path-port.js';
import type { Random } from '../ports/random.js';
import { retryTransient, WINDOWS_BUSY_RETRY } from './retry-transient.js';

function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** `PathPort` over `node:path` and `fs.realpath` for the running platform. */
export const nodePaths: PathPort = {
  isAbsolute: (path) => isAbsolute(path),
  async realpath(path) {
    try {
      return await realpath(path);
    } catch {
      return undefined;
    }
  },
  contains(parent, child) {
    const rel = relative(parent, child);
    if (rel === '') return true;
    // `..` as a whole first segment means outside; `..foo` is a legitimate child name.
    return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
  },
  join: (...segments) => join(...segments),
};

/** `FileSystem` over `node:fs/promises`. Temp-file names come from the `Random` port. */
export function createNodeFileSystem(random: Random): FileSystem {
  async function writeAtomic(path: string, data: string | Uint8Array, mode: number): Promise<void> {
    const temp = join(dirname(path), `.${toHex(random.bytes(6))}.tmp`);
    try {
      // `wx`: never follow or reuse an existing file; `mode` applies from creation.
      await writeFile(temp, data, { mode, flag: 'wx' });
      // A reader holding the target open makes a Windows rename fail for a moment.
      await retryTransient(() => rename(temp, path), WINDOWS_BUSY_RETRY);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  return {
    async readText(path) {
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    },
    writeTextAtomic: (path, text, mode) => writeAtomic(path, text, mode),
    async readBytes(path) {
      try {
        return new Uint8Array(await readFile(path));
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    },
    writeBytesAtomic: (path, bytes, mode) => writeAtomic(path, bytes, mode),
    async ensureDir(path, mode) {
      await mkdir(path, { recursive: true, mode });
    },
    async permissions(path) {
      try {
        return (await stat(path)).mode & 0o777;
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    },
    async chmod(path, mode) {
      await chmod(path, mode);
    },
    async remove(path) {
      try {
        // A script host still winding down keeps its file locked on Windows for a moment.
        await retryTransient(() => unlink(path), WINDOWS_BUSY_RETRY);
        return true;
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    },
  };
}
