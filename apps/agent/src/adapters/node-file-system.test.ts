import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNodeFileSystem, nodePaths } from './node-file-system.js';
import { systemRandom } from './system-random.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;

describe('nodePaths.contains', () => {
  it('is true for the parent itself and descendants, false otherwise', () => {
    expect(nodePaths.contains('/a/b', '/a/b')).toBe(true);
    expect(nodePaths.contains('/a/b', '/a/b/c')).toBe(true);
    expect(nodePaths.contains('/a/b', '/a/b/..c')).toBe(true);
    expect(nodePaths.contains('/a/b', '/a')).toBe(false);
    expect(nodePaths.contains('/a/b', '/a/bc')).toBe(false);
    expect(nodePaths.contains('/a/b', '/a/c')).toBe(false);
  });
});

describe('createNodeFileSystem', () => {
  let dir: string;
  const fs = createNodeFileSystem(systemRandom);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'remotectl-fs-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads missing files as undefined', async () => {
    expect(await fs.readText(join(dir, 'nope'))).toBeUndefined();
    expect(await fs.readText(join(dir, 'nope', 'deeper'))).toBeUndefined();
    expect(await fs.permissions(join(dir, 'nope'))).toBeUndefined();
  });

  it('rethrows other read errors', async () => {
    await expect(fs.readText(dir)).rejects.toMatchObject({ code: 'EISDIR' });
  });

  posixOnly('rethrows other stat errors', async () => {
    await writeFile(join(dir, 'f'), 'x');
    await expect(fs.permissions(`${join(dir, 'f')}\0`)).rejects.toBeDefined();
  });

  posixOnly('writes atomically with the given mode and leaves no temp file', async () => {
    const path = join(dir, 'secret.json');
    await fs.writeTextAtomic(path, 'one', 0o600);
    await fs.writeTextAtomic(path, 'two', 0o600);
    expect(await fs.readText(path)).toBe('two');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['secret.json']);
    await fs.chmod(path, 0o644);
    expect(await fs.permissions(path)).toBe(0o644);
  });

  it('cleans up the temp file when the rename fails', async () => {
    await fs.ensureDir(join(dir, 'target', 'occupied'), 0o700);
    await expect(fs.writeTextAtomic(join(dir, 'target'), 'x', 0o600)).rejects.toBeDefined();
    expect(await readdir(dir)).toEqual(['target']);
  });
});
