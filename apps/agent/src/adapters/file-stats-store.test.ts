import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FileSystem } from '../ports/file-system.js';
import { STATS_FILE, createFileStatsStore } from './file-stats-store.js';
import { createNodeFileSystem, nodePaths } from './node-file-system.js';
import { systemRandom } from './system-random.js';

const NOW = 1_791_763_200_000;
const counts = (fields: Record<string, number | null>) => ({
  approvals: 0,
  denials: 0,
  sessionsStarted: 0,
  toolCalls: 0,
  activeMs: 0,
  lastActiveAt: NOW,
  ...fields,
});

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
      clock: { now: () => NOW },
      onWarning: (message) => warnings.push(message),
    });
  }

  it('reads as empty before anything was counted', async () => {
    expect(await store().read()).toEqual({ version: 2, projects: {} });
  });

  it('keeps every count of concurrent records and survives a restart', async () => {
    const stats = store();
    await Promise.all([
      stats.record('api', { approvals: 1 }),
      stats.record('api', { approvals: 1 }),
      stats.record('api', { denials: 1 }),
      stats.record('web', { sessionsStarted: 1 }),
      stats.record('web', { toolCalls: 1, activeMs: 500 }),
    ]);
    expect(await store().read()).toEqual({
      version: 2,
      projects: {
        api: counts({ approvals: 2, denials: 1 }),
        web: counts({ sessionsStarted: 1, toolCalls: 1, activeMs: 500 }),
      },
    });
    expect(JSON.parse(await readFile(join(dir, STATS_FILE), 'utf8'))).toMatchObject({
      version: 2,
    });
  });

  it('upgrades a version 1 file and keeps its counts', async () => {
    await store().record('other', { toolCalls: 1 });
    await writeFile(
      join(dir, STATS_FILE),
      '{"version":1,"projects":{"api":{"approvals":4,"denials":1,"sessionsStarted":2}}}',
    );
    const stats = store();
    expect((await stats.read()).projects['api']).toEqual(
      counts({ approvals: 4, denials: 1, sessionsStarted: 2, lastActiveAt: null }),
    );
    await stats.record('api', { toolCalls: 1 });
    expect(await store().read()).toEqual({
      version: 2,
      projects: { api: counts({ approvals: 4, denials: 1, sessionsStarted: 2, toolCalls: 1 }) },
    });
  });

  posixOnly('writes the file 0600 in a 0700 directory (D22)', async () => {
    await store().record('api', { approvals: 1 });
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, STATS_FILE))).mode & 0o777).toBe(0o600);
  });

  it('starts over from a corrupt file', async () => {
    const stats = store();
    await stats.record('api', { approvals: 1 });
    await writeFile(join(dir, STATS_FILE), '{oops');
    expect(await stats.read()).toEqual({ version: 2, projects: {} });
    await stats.record('api', { denials: 1 });
    expect((await stats.read()).projects['api']).toEqual(counts({ denials: 1 }));
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
    await expect(stats.record('api', { approvals: 1 })).resolves.toBeUndefined();
    expect(warnings).toEqual([`could not update ${join(dir, STATS_FILE)}: disk full`]);
    fail = false;
    await stats.record('api', { approvals: 1 });
    expect((await stats.read()).projects['api']?.approvals).toBe(1);
  });

  it('reports a non-Error failure', async () => {
    const real = createNodeFileSystem(systemRandom);
    const stats = store({
      ...real,
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      ensureDir: () => Promise.reject('nope'),
    });
    await stats.record('api', { approvals: 1 });
    expect(warnings).toEqual([`could not update ${join(dir, STATS_FILE)}: nope`]);
  });
});
