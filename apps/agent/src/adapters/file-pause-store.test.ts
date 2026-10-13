import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pauseAt } from '../core/pause-state.js';
import type { FileSystem } from '../ports/file-system.js';
import { PAUSE_FILE, createFilePauseStore } from './file-pause-store.js';
import { createNodeFileSystem, nodePaths } from './node-file-system.js';
import { systemRandom } from './system-random.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;

describe('createFilePauseStore (M1-03)', () => {
  let base: string;
  let dir: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'remotectl-pause-'));
    dir = join(base, 'data');
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  function store(fs: FileSystem = createNodeFileSystem(systemRandom)) {
    return createFilePauseStore({ dir, fs, paths: nodePaths });
  }

  it('reads as not paused before anything was written', async () => {
    expect(await store().read()).toBeUndefined();
    expect(await store().clear()).toBe(false);
  });

  it('writes, reads back and clears the pause file', async () => {
    await store().write(pauseAt(1_000, 60_000));
    expect(await store().read()).toEqual({ version: 1, pausedAt: 1_000, until: 61_000 });
    expect(JSON.parse(await readFile(join(dir, PAUSE_FILE), 'utf8'))).toMatchObject({
      version: 1,
    });
    expect(await store().clear()).toBe(true);
    expect(await store().read()).toBeUndefined();
  });

  posixOnly('keeps the file owner-only (0600 in 0700)', async () => {
    await store().write(pauseAt(1_000));
    expect((await stat(join(dir, PAUSE_FILE))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it('reads a corrupt file as not paused', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, PAUSE_FILE), '{"version":1,');
    expect(await store().read()).toBeUndefined();
  });

  it('reads as not paused when the file cannot be read', async () => {
    const failing: FileSystem = {
      ...createNodeFileSystem(systemRandom),
      readText: () => Promise.reject(new Error('EACCES')),
    };
    expect(await store(failing).read()).toBeUndefined();
  });
});
