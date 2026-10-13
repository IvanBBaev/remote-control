import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { trustWorkspace, writeClaudeShim } from '@remote-control/fake-claude-code';

import {
  SpawnArgumentError,
  agentsArgv,
  claudeVersion,
  listAgents,
  resumeBackgroundSession,
  resumeSessionArgv,
  spawnBackgroundSession,
  startSessionArgv,
  startSessionInModeArgv,
  versionArgv,
} from './spawn.js';

const SESSION = '5b7c1e2a-9d3f-4e8a-b6c4-2f1d0e9a8b7c';

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

describe('startSessionInModeArgv (M2-09)', () => {
  it('builds the literal start argv with the mode right after --bg', () => {
    expect(startSessionInModeArgv('acceptEdits', 'rc-app-1', 'Fix it')).toEqual([
      '--bg',
      '--permission-mode',
      'acceptEdits',
      '--name',
      'rc-app-1',
      'Fix it',
    ]);
    expect(startSessionInModeArgv('plan', 'rc-app-1', 'Plan it')[2]).toBe('plan');
  });

  it('refuses every mode but plan and acceptEdits', () => {
    for (const mode of ['default', 'bypassPermissions', 'dontAsk', 'auto', '', '--bg']) {
      expect(() => startSessionInModeArgv(mode, 'name', 'ok')).toThrow(SpawnArgumentError);
    }
  });

  it('checks the name and the prompt like the plain start argv', () => {
    expect(() => startSessionInModeArgv('plan', 'a b', 'ok')).toThrow(SpawnArgumentError);
    expect(() => startSessionInModeArgv('plan', 'name', '-p')).toThrow(SpawnArgumentError);
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
      env: process.env,
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
        env: process.env,
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses an invalid mode synchronously, before starting anything', () => {
    expect(() =>
      spawnBackgroundSession({
        command: process.execPath,
        repository: repository(),
        name: 'session',
        prompt: 'hello',
        permissionMode: 'bypassPermissions' as 'plan',
        env: process.env,
      }),
    ).toThrow(SpawnArgumentError);
  });

  it('refuses invalid arguments synchronously, before starting anything', () => {
    expect(() =>
      spawnBackgroundSession({
        command: process.execPath,
        repository: repository(),
        name: 'bad name',
        prompt: 'hello',
        env: process.env,
      }),
    ).toThrow(SpawnArgumentError);
  });
});

describe('resumeSessionArgv, agentsArgv, versionArgv', () => {
  it('build the literal argv', () => {
    expect(resumeSessionArgv(SESSION, 'Run the tests')).toEqual([
      '--resume',
      SESSION,
      '--bg',
      'Run the tests',
    ]);
    expect(agentsArgv()).toEqual(['agents', '--json', '--all']);
    expect(versionArgv()).toEqual(['--version']);
  });

  it('refuses a session id that is not a UUID and a prompt that looks like an option', () => {
    for (const id of ['', '--settings', 'not-a-uuid', `${SESSION}x`]) {
      expect(() => resumeSessionArgv(id, 'ok')).toThrow(SpawnArgumentError);
    }
    expect(() => resumeSessionArgv(SESSION, '--permission-mode')).toThrow(SpawnArgumentError);
  });
});

// The `claude` shim is a POSIX script; Windows would need a shell to run `claude.cmd`.
describe.skipIf(process.platform === 'win32')('against fake-claude', () => {
  let base: string;
  let repo: string;
  let command: string;
  let env: Record<string, string | undefined>;
  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'remotectl-fake-')));
    repo = join(base, 'repo');
    await mkdir(repo);
    command = writeClaudeShim(join(base, 'bin'));
    env = { ...process.env, HOME: join(base, 'home'), FAKE_CLAUDE_SCENARIO: 'stop' };
    delete env['CLAUDE_CONFIG_DIR'];
    trustWorkspace(env, repo);
  });
  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const repository = () => ({ allowed: true as const, root: repo, realPath: repo });

  it('starts, lists and resumes a background session', async () => {
    const code = await spawnBackgroundSession({
      command,
      repository: repository(),
      name: 'rc-repo-1',
      prompt: 'Fix the tests',
      env,
    });
    expect(code).toBe(0);
    const roster = await listAgents(command, env);
    expect(roster.code).toBe(0);
    const entries = JSON.parse(roster.stdout) as { sessionId: string; name?: string }[];
    const entry = entries.find((row) => row.name === 'rc-repo-1');
    expect(entry).toBeDefined();
    const resumed = await resumeBackgroundSession({
      command,
      repository: repository(),
      sessionId: entry?.sessionId ?? SESSION,
      prompt: 'Now run them',
      env,
    });
    expect(resumed).toBe(0);
  });

  it('starts a session in a picked permission mode', async () => {
    const code = await spawnBackgroundSession({
      command,
      repository: repository(),
      name: 'rc-repo-2',
      prompt: 'Plan the tests',
      permissionMode: 'plan',
      env,
    });
    expect(code).toBe(0);
  });

  it('reports a failed resume through the exit code', async () => {
    const code = await resumeBackgroundSession({
      command,
      repository: repository(),
      sessionId: SESSION,
      prompt: 'Hello',
      env,
    });
    expect(code).toBe(1);
  });

  it('reads the version', async () => {
    const result = await claudeVersion(command, env);
    expect(result.stdout).toContain('(Claude Code)');
  });

  it('rejects a resume whose command cannot be started', async () => {
    await expect(
      resumeBackgroundSession({
        command: join(base, 'missing-claude'),
        repository: repository(),
        sessionId: SESSION,
        prompt: 'Hello',
        env,
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
