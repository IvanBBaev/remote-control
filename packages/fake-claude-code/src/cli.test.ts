import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type CliIo, DEFAULT_VERSION, compareVersions, main } from './cli.js';
import type { Env } from './paths.js';
import type { AgentEntry } from './roster.js';
import { FAKE_CLAUDE_BIN, writeClaudeShim } from './shim.js';
import { TempEnv } from './test-env.js';
import { seededRandom, steppingClock } from './testing.js';

let t: TempEnv;
let seed = 0;

beforeEach(() => {
  t = new TempEnv();
});

afterEach(() => {
  t.cleanup();
});

async function run(
  argv: string[],
  overrides: { env?: Env; cwd?: string } = {},
): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const io: CliIo = {
    env: overrides.env ?? t.env,
    cwd: overrides.cwd ?? t.cwd,
    stdout: (text) => (out += text),
    stderr: (text) => (err += text),
    clock: steppingClock(),
    random: seededRandom((seed += 1)),
    pid: 4242,
  };
  const code = await main(argv, io);
  return { code, out, err };
}

async function agents(...extra: string[]): Promise<AgentEntry[]> {
  const { out } = await run(['agents', '--json', ...extra]);
  return JSON.parse(out) as AgentEntry[];
}

describe('fake-claude CLI (04 §2.8, §5.4)', () => {
  it('--version prints "<version> (Claude Code)", overridable with FAKE_CLAUDE_VERSION', async () => {
    expect(await run(['--version'])).toMatchObject({
      code: 0,
      out: `${DEFAULT_VERSION} (Claude Code)\n`,
    });
    expect((await run(['-v'], { env: { ...t.env, FAKE_CLAUDE_VERSION: '2.1.250' } })).out).toBe(
      '2.1.250 (Claude Code)\n',
    );
  });

  it('--bg in an untrusted directory fails with "Workspace not trusted"', async () => {
    const result = await run(['--bg', '--name', 'job', 'hello']);
    expect(result).toMatchObject({ code: 1, err: 'Workspace not trusted\n' });
    expect(await agents('--all')).toEqual([]);
  });

  it('--bg with -p is rejected', async () => {
    t.trust();
    const result = await run(['-p', '--bg', 'hello']);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/--bg cannot be used with -p/);
  });

  it('--bg --name runs a background session that agents --json lists by name and cwd', async () => {
    t.trust();
    t.userSettings({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: t.hook('') }] }] },
    });
    const result = await run(['--bg', '--name', 'fix-tests', 'Make the tests pass']);
    expect(result.code).toBe(0);
    const [entry] = await agents('--all');
    expect(result.out).toBe(`Started background session ${entry?.sessionId ?? ''}\n`);
    expect(entry).toMatchObject({
      name: 'fix-tests',
      kind: 'background',
      cwd: t.cwd,
      state: 'done',
      pid: 4242,
    });
    expect(entry?.id).toBe(entry?.sessionId.slice(0, 8));
    expect(t.calls()[0]?.input.prompt).toBe('Make the tests pass');
    // Without --all only live sessions are listed.
    expect(await agents()).toEqual([]);
    expect(await agents('--all', '--cwd', t.root)).toEqual([]);
    expect(await agents('--all', '--cwd', '.')).toHaveLength(1);
  });

  it('--bg honours FAKE_CLAUDE_SCENARIO, --scenario and --permission-mode', async () => {
    t.trust();
    t.userSettings({
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: t.hook('') }] }] },
    });
    await run(['--bg', '--permission-mode', 'acceptEdits', 'q'], {
      env: { ...t.env, FAKE_CLAUDE_SCENARIO: 'question' },
    });
    await run(['--bg', '--scenario', 'permission', 'p']);
    const calls = t.calls().map((call) => call.input);
    expect(calls[0]).toMatchObject({
      tool_name: 'AskUserQuestion',
      permission_mode: 'acceptEdits',
    });
    expect(calls[1]).toMatchObject({ tool_name: 'Bash', permission_mode: 'default' });
  });

  it('--resume <uuid> --bg continues the same session ID from 2.1.257 and forks before', async () => {
    t.trust();
    t.userSettings({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: t.hook('') }] }] },
    });
    await run(['--bg', '--name', 'n', 'first']);
    const [first] = await agents('--all');
    const id = first?.sessionId ?? '';
    await run(['--resume', id, '--bg', 'follow-up']);
    expect((await agents('--all')).map((entry) => entry.sessionId)).toEqual([id]);
    await run(['--resume', id, '--bg', 'old'], {
      env: { ...t.env, FAKE_CLAUDE_VERSION: '2.1.256' },
    });
    const after = await agents('--all');
    expect(after).toHaveLength(2);
    expect(after.every((entry) => entry.name === 'n')).toBe(true);
    expect(t.calls().map((call) => call.input.source)).toEqual(['startup', 'resume', 'resume']);
  });

  it('--resume with an unknown session ID fails', async () => {
    t.trust();
    const result = await run(['--resume', '00000000-0000-4000-8000-000000000000', '--bg', 'x']);
    expect(result).toMatchObject({
      code: 1,
      err: expect.stringMatching(/No conversation found/) as unknown,
    });
  });

  it('fire <Event> runs one event against the hooks: exit 0 allow, 2 deny, 1 none', async () => {
    const decide = (behavior: string) =>
      t.hook(
        `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: '${behavior}' } } }));`,
      );
    t.userSettings({
      hooks: {
        PermissionRequest: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: decide('allow') }] },
          { matcher: 'Write', hooks: [{ type: 'command', command: decide('deny') }] },
        ],
      },
    });
    const allowed = await run(['fire', 'PermissionRequest', '--fixture', 'bash-rm-rf']);
    expect(allowed.code).toBe(0);
    expect(JSON.parse(allowed.out)).toMatchObject({
      event: 'PermissionRequest',
      decision: 'allow',
    });
    expect(t.calls()[0]?.input.cwd).toBe('/home/synthetic/project');

    const input = join(t.root, 'write.json');
    writeFileSync(
      input,
      JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: {} }),
    );
    expect((await run(['fire', 'PermissionRequest', '--input', input])).code).toBe(2);
    expect((await run(['fire', 'Stop', '--input', input])).code).toBe(1);
  });

  it('scenario <name> runs in the foreground and prints the session result', async () => {
    const result = await run(['scenario', 'question', 'Pick one']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out) as { answers: unknown[]; fired: { event: string }[] };
    expect(parsed.answers).toEqual([{}]);
    expect((await agents('--all'))[0]).toMatchObject({ kind: 'interactive' });
    const file = join(t.root, 'custom.json');
    writeFileSync(
      file,
      JSON.stringify({
        name: 'custom',
        steps: [
          { kind: 'notification', notificationType: 'idle_prompt', message: 'm', title: 't' },
        ],
      }),
    );
    t.userSettings('{"hooks": 1}');
    const custom = await run(['scenario', file]);
    expect(custom.err).toMatch(/warning: .*"hooks" is not an object/);
    const fired = (JSON.parse(custom.out) as { fired: { event: string }[] }).fired;
    expect(fired.map((fire) => fire.event)).toEqual(['SessionStart', 'Notification', 'SessionEnd']);
  });

  it('rejects bad usage with exit 2', async () => {
    for (const argv of [
      [],
      ['agents'],
      ['fire', 'Nope'],
      ['fire', 'Stop'],
      ['scenario'],
      ['--bg', '--name'],
    ]) {
      expect((await run(argv)).code).toBe(2);
    }
    const missing = join(t.root, 'missing.json');
    expect((await run(['scenario', missing])).code).toBe(1);
    writeFileSync(missing, '{}');
    expect((await run(['scenario', missing])).err).toMatch(/scenario without steps/);
  });

  it('compareVersions orders dotted versions numerically', () => {
    expect(compareVersions('2.1.257', '2.1.257')).toBe(0);
    expect(compareVersions('2.1.300', '2.1.257')).toBe(1);
    expect(compareVersions('2.1', '2.1.1')).toBe(-1);
  });
});

describe('fake-claude executable', () => {
  it('runs through tsx as a real process, also via the `claude` shim on PATH', () => {
    const direct = spawnSync(process.execPath, [FAKE_CLAUDE_BIN, '--version'], {
      encoding: 'utf8',
      env: t.env,
    });
    expect(direct.stdout).toBe(`${DEFAULT_VERSION} (Claude Code)\n`);
    expect(direct.status).toBe(0);
    const failing = spawnSync(process.execPath, [FAKE_CLAUDE_BIN, '--bg', 'x'], {
      encoding: 'utf8',
      env: t.env,
      cwd: t.cwd,
    });
    expect(failing.status).toBe(1);
    expect(failing.stderr).toBe('Workspace not trusted\n');

    const binDir = join(t.root, 'bin');
    writeClaudeShim(binDir);
    // The POSIX script needs /bin/sh; the claude.cmd twin is what Windows resolves.
    const shimmed =
      process.platform === 'win32'
        ? spawnSync('claude.cmd', ['--version'], {
            encoding: 'utf8',
            env: { ...t.env, PATH: binDir },
            shell: true,
          })
        : spawnSync(join(binDir, 'claude'), ['--version'], { encoding: 'utf8', env: t.env });
    expect(shimmed.stdout.trim()).toBe(`${DEFAULT_VERSION} (Claude Code)`);
  }, 30_000);
});
