import { mkdir, mkdtemp, realpath, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { trustWorkspace, writeClaudeShim } from '@remote-control/fake-claude-code';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createClaudeCli, parseClaudeVersion, parseRoster } from './claude-cli.js';

describe('parseClaudeVersion', () => {
  it('reads the semantic version and nothing else', () => {
    expect(parseClaudeVersion('2.1.300 (Claude Code)\n')).toBe('2.1.300');
    expect(parseClaudeVersion('  2.2.0\n')).toBe('2.2.0');
    expect(parseClaudeVersion('Claude Code 2.1.300')).toBeUndefined();
    expect(parseClaudeVersion('')).toBeUndefined();
  });
});

describe('parseRoster', () => {
  const row = {
    sessionId: 's-1',
    cwd: '/work/a',
    kind: 'background',
    state: 'working',
    status: 'busy',
    name: 'rc-a-1',
  };

  it('keeps well-formed rows and normalises optional fields', () => {
    expect(parseRoster(JSON.stringify([row]))).toEqual([row]);
    expect(
      parseRoster(JSON.stringify([{ ...row, status: 'sleeping', name: 'x'.repeat(65) }])),
    ).toEqual([{ ...row, status: undefined, name: undefined }]);
    expect(parseRoster(JSON.stringify([{ ...row, status: 3, name: '' }]))).toEqual([
      { ...row, status: undefined, name: undefined },
    ]);
  });

  it('skips rows it cannot read', () => {
    const bad = [
      null,
      'row',
      { ...row, sessionId: '' },
      { ...row, sessionId: 'x'.repeat(129) },
      { ...row, sessionId: 7 },
      { ...row, cwd: '' },
      { ...row, kind: 'daemon' },
      { ...row, state: 'paused' },
      { ...row, state: undefined },
    ];
    expect(parseRoster(JSON.stringify([...bad, row]))).toEqual([row]);
  });

  it('is undefined for output that is not a JSON array', () => {
    expect(parseRoster('not json')).toBeUndefined();
    expect(parseRoster('{"sessions":[]}')).toBeUndefined();
  });
});

// The `claude` shim is a POSIX script; Windows would need a shell to run `claude.cmd`.
describe.skipIf(process.platform === 'win32')('createClaudeCli', () => {
  let base: string;
  let repo: string;
  let env: Record<string, string | undefined>;
  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'remotectl-cli-')));
    repo = join(base, 'repo');
    await mkdir(repo);
    writeClaudeShim(join(base, 'bin'));
    env = { ...process.env, HOME: join(base, 'home'), FAKE_CLAUDE_SCENARIO: 'stop' };
    delete env['CLAUDE_CONFIG_DIR'];
    trustWorkspace(env, repo);
  });
  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const repository = () => ({ allowed: true as const, root: repo, realPath: repo });

  it('starts a session, finds it in the roster and resumes it', async () => {
    const cli = createClaudeCli({ command: join(base, 'bin', 'claude'), env });
    expect(await cli.version()).toBe('2.1.300');
    expect(await cli.start(repository(), 'rc-repo-2', 'Fix the tests')).toBe(0);
    const entry = (await cli.agents())?.find((row) => row.name === 'rc-repo-2');
    expect(entry).toMatchObject({ cwd: repo, kind: 'background' });
    expect(await cli.resume(repository(), entry?.sessionId ?? '', 'Run them')).toBe(0);
  });

  it('is undefined when the CLI is missing or fails', async () => {
    const missing = createClaudeCli({ command: join(base, 'missing'), env });
    expect(await missing.version()).toBeUndefined();
    expect(await missing.agents()).toBeUndefined();
    const failing = join(base, 'failing');
    await writeFile(failing, '#!/bin/sh\nexit 3\n');
    await chmod(failing, 0o755);
    const broken = createClaudeCli({ command: failing, env });
    expect(await broken.version()).toBeUndefined();
    expect(await broken.agents()).toBeUndefined();
  });
});
