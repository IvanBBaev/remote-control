import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FileSystem } from '../ports/file-system.js';
import { STATS_FILE, createFileStatsStore } from './file-stats-store.js';
import { createNodeFileSystem, nodePaths } from './node-file-system.js';
import { systemRandom } from './system-random.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;

describe('createFileStatsStore', () => {
  let base: string;
  let dir: string;
  let warnings: string[];

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'remotectl-stats-'));
    dir = join(base, 'data');
    warnings = [];
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  function store(fs: FileSystem = createNodeFileSystem(systemRandom)) {
    return createFileStatsStore({
      dir,
      fs,
      paths: nodePaths,
      onWarning: (message) => warnings.push(message),
    });
  }

  it('reads as empty before anything was counted', async () => {
    expect(await store().read()).toEqual({ version: 1, projects: {} });
  });

  it('keeps every count of concurrent records and survives a restart', async () => {
    const stats = store();
    await Promise.all([
      stats.record('api', 'approvals'),
      stats.record('api', 'approvals'),
      stats.record('api', 'denials'),
      stats.record('web', 'sessionsStarted'),
    ]);
    expect(await store().read()).toEqual({
      version: 1,
      projects: {
        api: { approvals: 2, denials: 1, sessionsStarted: 0 },
        web: { approvals: 0, denials: 0, sessionsStarted: 1 },
      },
    });
    expect(JSON.parse(await readFile(join(dir, STATS_FILE), 'utf8'))).toMatchObject({
      version: 1,
    });
  });

  posixOnly('writes the file 0600 in a 0700 directory (D22)', async () => {
    await store().record('api', 'approvals');
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, STATS_FILE))).mode & 0o777).toBe(0o600);
  });

  it('starts over from a corrupt file', async () => {
    const stats = store();
    await stats.record('api', 'approvals');
    await writeFile(join(dir, STATS_FILE), '{oops');
    expect(await stats.read()).toEqual({ version: 1, projects: {} });
    await stats.record('api', 'denials');
    expect((await stats.read()).projects['api']).toEqual({
      approvals: 0,
      denials: 1,
      sessionsStarted: 0,
    });
  });

  it('reports a failed write and keeps counting afterwards', async () => {
    const real = createNodeFileSystem(systemRandom);
    let fail = true;
    const flaky: FileSystem = {
      ...real,
      writeTextAtomic: (path, text, mode) =>
        fail ? Promise.reject(new Error('disk full')) : real.writeTextAtomic(path, text, mode),
    };
    const stats = store(flaky);
    await expect(stats.record('api', 'approvals')).resolves.toBeUndefined();
    expect(warnings).toEqual([`could not update ${join(dir, STATS_FILE)}: disk full`]);
    fail = false;
    await stats.record('api', 'approvals');
    expect((await stats.read()).projects['api']?.approvals).toBe(1);
  });

  it('reports a non-Error failure', async () => {
    const real = createNodeFileSystem(systemRandom);
    const stats = store({
      ...real,
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      ensureDir: () => Promise.reject('nope'),
    });
    await stats.record('api', 'approvals');
    expect(warnings).toEqual([`could not update ${join(dir, STATS_FILE)}: nope`]);
  });
});
