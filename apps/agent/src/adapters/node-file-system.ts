import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import { toHex } from '@remote-control/protocol';

import type { FileSystem } from '../ports/file-system.js';
import type { PathPort } from '../ports/path-port.js';
import type { Random } from '../ports/random.js';

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
  return {
    async readText(path) {
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    },
    async writeTextAtomic(path, text, mode) {
      const temp = join(dirname(path), `.${toHex(random.bytes(6))}.tmp`);
      try {
        // `wx`: never follow or reuse an existing file; `mode` applies from creation.
        await writeFile(temp, text, { mode, flag: 'wx' });
        await rename(temp, path);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
    },
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
  };
}
