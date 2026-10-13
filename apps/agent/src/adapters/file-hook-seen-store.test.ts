import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FileSystem } from '../ports/file-system.js';
import { HOOK_SEEN_FILE, createFileHookSeenStore } from './file-hook-seen-store.js';
import { createNodeFileSystem, nodePaths } from './node-file-system.js';
import { systemRandom } from './system-random.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;

describe('createFileHookSeenStore (M1-07)', () => {
  let base: string;
  let dir: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'remotectl-hook-seen-'));
    dir = join(base, 'data');
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  function store(fs: FileSystem = createNodeFileSystem(systemRandom)) {
    return createFileHookSeenStore({ dir, fs, paths: nodePaths });
  }

  it('reads as empty before anything was recorded', async () => {
    expect(await store().read()).toEqual({});
  });

  it('records each root once, keeping the first time', async () => {
    const s = store();
    await s.record('/src/api', 1_000);
    await s.record('/src/api', 2_000);
    await s.record('/src/web', 3_000);
    expect(await store().read()).toEqual({ '/src/api': 1_000, '/src/web': 3_000 });
    expect(JSON.parse(await readFile(join(dir, HOOK_SEEN_FILE), 'utf8'))).toMatchObject({
      version: 1,
    });
  });

  it('loses no root in a burst of records', async () => {
    const s = store();
    await Promise.all(['/a', '/b', '/c', '/d'].map((root, i) => s.record(root, i)));
    expect(Object.keys(await s.read()).sort()).toEqual(['/a', '/b', '/c', '/d']);
  });

  posixOnly('keeps the file owner-only (0600 in 0700)', async () => {
    await store().record('/src/api', 1);
    expect((await stat(join(dir, HOOK_SEEN_FILE))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it('reads a corrupt or unknown file as empty', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, HOOK_SEEN_FILE), '{"version":1,');
    expect(await store().read()).toEqual({});
    await writeFile(join(dir, HOOK_SEEN_FILE), '{"version":2,"roots":{}}');
    expect(await store().read()).toEqual({});
  });

  it('rejects a failed write and keeps accepting later ones', async () => {
    const real = createNodeFileSystem(systemRandom);
    let fail = true;
    const flaky: FileSystem = {
      ...real,
      writeTextAtomic: (...args) =>
        fail ? Promise.reject(new Error('ENOSPC')) : real.writeTextAtomic(...args),
    };
    const s = store(flaky);
    await expect(s.record('/a', 1)).rejects.toThrow('ENOSPC');
    fail = false;
    await s.record('/b', 2);
    expect(await s.read()).toEqual({ '/b': 2 });
  });
});
