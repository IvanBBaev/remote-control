import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNodeFileSystem, nodePaths } from '../adapters/node-file-system.js';
import { systemRandom } from '../adapters/system-random.js';
import {
  FEED_EVENTS,
  HOOK_SCRIPT_FILE,
  HooksSettingsError,
  createHooksInstaller,
  hookCommand,
  hookSpecs,
  installOwnHooks,
  isOwnCommand,
  removeOwnHooks,
} from './hooks-installer.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;
const NOW = Date.UTC(2026, 9, 12, 10, 30, 0);
const EXEC = '/usr/local/bin/node';

/** The owner's real-world shape: a usage monitor and an agenthropic feed hook. */
const FIXTURE = `{
  "model": "opus",
  "permissions": {
    "allow": ["Bash(pnpm check)"]
  },
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.claude/usage-monitor.js"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "node ~/.claude/usage-monitor.js", "timeout": 10 },
          { "type": "command", "command": "curl -s -X POST http://127.0.0.1:4317/events -d @-" }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /Users/owner/Development/agenthropic/hooks/collect.js"
          }
        ]
      }
    ]
  },
  "statusLine": { "type": "command", "command": "~/.claude/statusline.sh" }
}
`;

describe('hooks installer', () => {
  let base: string;
  let settingsDir: string;
  let dataDir: string;
  let hookSource: string;
  let settingsPath: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'remotectl-hooks-'));
    settingsDir = join(base, 'claude');
    dataDir = join(base, 'data', 'remotectl');
    hookSource = join(base, 'pkg', 'hook.cjs');
    settingsPath = join(settingsDir, 'settings.json');
    await mkdir(join(base, 'pkg'));
    await writeFile(hookSource, '// hook v1\n');
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const installer = (holdSeconds = 1800, now = NOW) =>
    createHooksInstaller({
      fs: createNodeFileSystem(systemRandom),
      paths: nodePaths,
      clock: { now: () => now },
      settingsDir,
      dataDir,
      hookSource,
      execPath: EXEC,
      holdSeconds,
    });

  const writeSettings = async (text: string): Promise<void> => {
    await mkdir(settingsDir, { recursive: true });
    await writeFile(settingsPath, text, { mode: 0o600 });
  };

  it('installs next to foreign entries and remove restores the fixture byte for byte', async () => {
    await writeSettings(FIXTURE);
    const hooks = installer();
    const result = await hooks.install();
    expect(result.changed).toBe(true);
    expect(result.backupPath).toBe(`${settingsPath}.backup-2026-10-12T10-30-00-000Z`);
    expect(await readFile(result.backupPath!, 'utf8')).toBe(FIXTURE);

    const installed = await readFile(settingsPath, 'utf8');
    // Only our entries were added: stripping them gives the original bytes.
    expect(removeOwnHooks(installed, settingsPath)).toBe(FIXTURE);
    const parsed = JSON.parse(installed) as { hooks: Record<string, unknown[]> };
    const original = JSON.parse(FIXTURE) as { hooks: Record<string, unknown[]> };
    for (const [event, groups] of Object.entries(original.hooks)) {
      expect(parsed.hooks[event]!.slice(0, groups.length)).toEqual(groups);
    }
    const script = join(dataDir, HOOK_SCRIPT_FILE);
    expect(parsed.hooks['PermissionRequest']).toEqual([
      { hooks: [{ type: 'command', command: hookCommand(EXEC, script, 1800), timeout: 1800 }] },
    ]);
    expect(parsed.hooks['PreToolUse']).toEqual([
      {
        matcher: '^AskUserQuestion$',
        hooks: [{ type: 'command', command: hookCommand(EXEC, script, 1800), timeout: 1800 }],
      },
    ]);
    for (const event of FEED_EVENTS) {
      expect(parsed.hooks[event]!.at(-1)).toEqual({
        hooks: [{ type: 'command', command: hookCommand(EXEC, script, 5), timeout: 5 }],
      });
    }
    expect(await readFile(script, 'utf8')).toBe('// hook v1\n');

    expect(await hooks.install()).toMatchObject({ changed: false });

    const removed = await installer(1800, NOW + 1000).remove();
    expect(removed.changed).toBe(true);
    expect(await readFile(settingsPath, 'utf8')).toBe(FIXTURE);
    expect(await installer().remove()).toMatchObject({ changed: false });
  });

  posixOnly('keeps the settings mode and writes owner-only backups', async () => {
    await writeSettings(FIXTURE);
    const { backupPath } = await installer().install();
    expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
    expect((await stat(backupPath!)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dataDir, HOOK_SCRIPT_FILE))).mode & 0o777).toBe(0o600);
  });

  it('creates a missing settings file without a backup', async () => {
    const result = await installer().install();
    expect(result).toMatchObject({ changed: true });
    expect(result.backupPath).toBeUndefined();
    const text = await readFile(settingsPath, 'utf8');
    expect(Object.keys((JSON.parse(text) as { hooks: object }).hooks)).toHaveLength(10);
    await installer().remove();
    expect(await readFile(settingsPath, 'utf8')).toBe('{}\n');
    expect(await installer().remove()).toMatchObject({ changed: false });
  });

  it('does nothing on remove when there is no settings file', async () => {
    expect(await installer().remove()).toMatchObject({ changed: false });
    await expect(stat(settingsPath)).rejects.toThrow();
  });

  it.each([
    ['corrupt JSON', '{ "hooks": ', /not valid JSON/],
    ['a non-object root', '[]', /top level is not a JSON object/],
    ['a non-object hooks', '{ "hooks": [] }', /"hooks" is not an object/],
    ['a non-array event', '{ "hooks": { "Stop": {} } }', /"hooks.Stop" is not an array/],
  ])('refuses %s and leaves the file untouched', async (_name, text, message) => {
    await writeSettings(text);
    await expect(installer().install()).rejects.toThrow(HooksSettingsError);
    await expect(installer().install()).rejects.toThrow(message);
    expect(await readFile(settingsPath, 'utf8')).toBe(text);
    expect((await readdir(settingsDir)).filter((name) => name.includes('backup'))).toEqual([]);
  });

  posixOnly('writes through a symlinked settings.json to its target', async () => {
    const target = join(base, 'dotfiles', 'settings.json');
    await mkdir(join(base, 'dotfiles'));
    await writeFile(target, FIXTURE, { mode: 0o644 });
    await mkdir(settingsDir);
    await symlink(target, settingsPath);
    await installer().install();
    expect(removeOwnHooks(await readFile(target, 'utf8'), target)).toBe(FIXTURE);
    expect((await stat(target)).mode & 0o777).toBe(0o644);
    await installer().remove();
    expect(await readFile(target, 'utf8')).toBe(FIXTURE);
  });

  it('refuses to install without the bundled hook script', async () => {
    await rm(hookSource);
    await expect(installer().install()).rejects.toThrow(/hook script not found/);
    await expect(stat(settingsPath)).rejects.toThrow();
  });

  it('reports installed, outdated and missing hooks and the script state', async () => {
    let status = await installer().status();
    expect(status).toMatchObject({ settingsExists: false, script: 'missing' });
    expect(status.hooks.every((hook) => hook.state === 'missing')).toBe(true);
    expect(status.hooks[1]).toEqual({
      event: 'PreToolUse',
      matcher: '^AskUserQuestion$',
      state: 'missing',
    });

    await installer().install();
    status = await installer().status();
    expect(status).toMatchObject({ settingsExists: true, script: 'current' });
    expect(status.hooks.every((hook) => hook.state === 'installed')).toBe(true);

    // A different holdSeconds makes the blocking hooks outdated; reinstall fixes them.
    status = await installer(600).status();
    expect(status.hooks.map((hook) => hook.state)).toEqual([
      'outdated',
      'outdated',
      ...FEED_EVENTS.map(() => 'installed'),
    ]);
    await installer(600).install();
    expect((await installer(600).status()).hooks.every((hook) => hook.state === 'installed')).toBe(
      true,
    );

    await writeFile(hookSource, '// hook v2\n');
    expect((await installer(600).status()).script).toBe('outdated');
    await rm(hookSource);
    expect((await installer(600).status()).script).toBe('current');
  });
});

describe('own-entry recognition', () => {
  it('matches our script paths only', () => {
    expect(isOwnCommand('"/n" "/Users/a/Library/Application Support/remotectl/hook.cjs" 5')).toBe(
      true,
    );
    expect(
      isOwnCommand('"C:\\node.exe" "C:\\Users\\a\\AppData\\Local\\remotectl\\Data\\hook.cjs" 5'),
    ).toBe(true);
    expect(isOwnCommand('node ~/.remote-control/hook.js')).toBe(true);
    expect(isOwnCommand('node ~/.claude/usage-monitor.js')).toBe(false);
    expect(isOwnCommand('node ~/remotectl-tools/hook.cjs')).toBe(false);
  });

  it('replaces a legacy entry and a duplicated one in place of the old set', () => {
    const legacy = `{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node ~/.remote-control/hook.js" }] },
      {
        "hooks": [
          { "type": "command", "command": "node ~/.claude/usage-monitor.js" },
          { "type": "command", "command": "node ~/.remote-control/hook.js" }
        ]
      }
    ]
  }
}
`;
    const next = installOwnHooks(legacy, 'settings.json', hookSpecs(1800), (spec) =>
      hookCommand(EXEC, '/data/remotectl/hook.cjs', spec.timeout),
    );
    const stop = (JSON.parse(next) as { hooks: Record<string, unknown[]> }).hooks['Stop'];
    expect(stop).toEqual([
      { hooks: [{ type: 'command', command: 'node ~/.claude/usage-monitor.js' }] },
      {
        hooks: [{ type: 'command', command: `"${EXEC}" "/data/remotectl/hook.cjs" 5`, timeout: 5 }],
      },
    ]);
  });
});
