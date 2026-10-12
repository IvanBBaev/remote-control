import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SpawnArgumentError, spawnBackgroundSession, startSessionArgv } from './spawn.js';

describe('startSessionArgv', () => {
  it('builds the literal start argv', () => {
    expect(startSessionArgv('fix-tests_1.2', 'Fix the failing tests')).toEqual([
      '--bg',
      '--name',
      'fix-tests_1.2',
      'Fix the failing tests',
    ]);
  });

  it('refuses names that are not a plain token', () => {
    for (const name of ['', '-x', '--settings', 'a b', 'a/b', 'x'.repeat(65), 'ä']) {
      expect(() => startSessionArgv(name, 'ok')).toThrow(SpawnArgumentError);
    }
  });

  it('refuses prompts that could be read as options or are out of bounds', () => {
    for (const prompt of ['', '-p', '--dangerously-skip-permissions', 'a\0b', 'x'.repeat(32_769)]) {
      expect(() => startSessionArgv('name', prompt)).toThrow(SpawnArgumentError);
    }
    expect(startSessionArgv('name', 'x'.repeat(32_768))).toHaveLength(4);
  });
});

describe('spawnBackgroundSession', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'remotectl-spawn-')));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const repository = () => ({ allowed: true as const, root: dir, realPath: dir });

  it('runs the command without a shell and resolves with its exit code', async () => {
    // `node --bg` is not a valid Node option, so Node exits with a non-zero code.
    const code = await spawnBackgroundSession({
      command: process.execPath,
      repository: repository(),
      name: 'session',
      prompt: 'hello',
    });
    expect(code).not.toBe(0);
  });

  it('rejects when the command cannot be started', async () => {
    await expect(
      spawnBackgroundSession({
        command: join(dir, 'missing-claude'),
        repository: repository(),
        name: 'session',
        prompt: 'hello',
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses invalid arguments synchronously, before starting anything', () => {
    expect(() =>
      spawnBackgroundSession({
        command: process.execPath,
        repository: repository(),
        name: 'bad name',
        prompt: 'hello',
      }),
    ).toThrow(SpawnArgumentError);
  });
});
