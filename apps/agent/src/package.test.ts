import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  HookRunner,
  loadHooks,
  permissionRequestPayload,
  stopPayload,
} from '@remote-control/fake-claude-code';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runCli } from './cli/main.js';
import { createContainer } from './container.js';
import { createHookDispatcher } from './core/hook-dispatcher.js';
import { createPendingStore } from './core/pending-store.js';

const run = promisify(execFile);
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const BUNDLE = join(PACKAGE_DIR, 'dist', 'cli.mjs');
const HOOK_BUNDLE = join(PACKAGE_DIR, 'dist', 'hook.cjs');
const BUILTINS = new Set(builtinModules);

interface PackFile {
  readonly path: string;
}

/** Static and runtime imports the bundler emitted (code only, not comments). */
function bundleSpecifiers(code: string): string[] {
  const found = new Set<string>();
  for (const pattern of [
    /^import\s[^;]*?from\s*"([^"]+)";?$/gm,
    /^import\s*"([^"]+)";?$/gm,
    /\b__require\("([^"]+)"\)/g,
    /\bimport\("([^"]+)"\)/g,
  ]) {
    for (const match of code.matchAll(pattern)) found.add(match[1] as string);
  }
  return [...found].sort();
}

function isBuiltin(specifier: string): boolean {
  return BUILTINS.has(specifier.startsWith('node:') ? specifier.slice(5) : specifier);
}

beforeAll(async () => {
  await run('pnpm', ['run', 'build'], { cwd: PACKAGE_DIR });
}, 120_000);

/** AC: the published package is bundled with no runtime dependency (D22, R13). */
describe('npm package', () => {
  let home: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'remotectl-pack-'));
  });

  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('declares no runtime dependencies, no install scripts and a bin', async () => {
    const pkg = JSON.parse(await readFile(join(PACKAGE_DIR, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(pkg['dependencies']).toBeUndefined();
    expect(pkg['optionalDependencies']).toBeUndefined();
    expect(pkg['peerDependencies']).toBeUndefined();
    expect(pkg['bundledDependencies']).toBeUndefined();
    const scripts = (pkg['scripts'] ?? {}) as Record<string, string>;
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
      expect(scripts[hook]).toBeUndefined();
    }
    expect(pkg['bin']).toEqual({ remotectl: 'dist/cli.mjs' });
  });

  it('packs only the bundles, the source map, the README and package.json', async () => {
    const { stdout } = await run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: PACKAGE_DIR,
    });
    const [packed] = JSON.parse(stdout) as [{ files: PackFile[]; bundled: string[] }];
    expect(packed.files.map((file) => file.path).sort()).toEqual([
      'README.md',
      'dist/cli.mjs',
      'dist/cli.mjs.map',
      'dist/hook.cjs',
      'package.json',
    ]);
    expect(packed.bundled).toEqual([]);
  });

  it('bundles everything except Node builtins', async () => {
    const code = await readFile(BUNDLE, 'utf8');
    expect(code.startsWith('#!/usr/bin/env node\n')).toBe(true);
    const specifiers = bundleSpecifiers(code);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((specifier) => !isBuiltin(specifier))).toEqual([]);
  });

  it('bundles hook.cjs as CommonJS with Node builtins only', async () => {
    const code = await readFile(HOOK_BUNDLE, 'utf8');
    expect(code).not.toMatch(/^import\s/m);
    expect(code).not.toMatch(/^export\s/m);
    const specifiers = [...code.matchAll(/\brequire\("([^"]+)"\)/g)].map(
      (match) => match[1] as string,
    );
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((specifier) => !isBuiltin(specifier))).toEqual([]);
  });

  it('runs: --help lists the commands', async () => {
    const { stdout } = await run(process.execPath, [BUNDLE, '--help']);
    for (const command of ['run', 'status', 'pair', 'devices', 'hooks install', 'logs', 'update']) {
      expect(stdout).toContain(`  ${command}`);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'runs: `run` logs through pino-roll and stops on SIGTERM',
    async () => {
      const env = {
        PATH: process.env['PATH'],
        HOME: home,
        XDG_CONFIG_HOME: join(home, 'config'),
        XDG_DATA_HOME: join(home, 'data'),
        XDG_STATE_HOME: join(home, 'state'),
        XDG_CACHE_HOME: join(home, 'cache'),
        // No npm registry request from a test.
        REMOTECTL_NO_UPDATE_CHECK: '1',
      };
      // Port 0: the test never collides with an agent running on this machine.
      const configDir =
        process.platform === 'darwin'
          ? join(home, 'Library', 'Preferences', 'remotectl')
          : join(home, 'config', 'remotectl');
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, 'config.json'), JSON.stringify({ hooks: { port: 0 } }));
      const child = spawn(process.execPath, [BUNDLE, 'run'], { env, stdio: 'pipe' });
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
      await vi.waitFor(() => expect(stdout).toContain('running'), { timeout: 10_000 });
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      const logDir =
        process.platform === 'darwin'
          ? join(home, 'Library', 'Logs', 'remotectl')
          : join(home, 'state', 'remotectl');
      expect(await readdir(logDir)).toContain('agent.1.log');
      const log = await readFile(join(logDir, 'agent.1.log'), 'utf8');
      expect(log).toContain('"event":"agent_start"');
      expect(log).toContain('"event":"agent_stop"');
    },
    20_000,
  );
});

/** hook.cjs run by the fake Claude Code against the real receiver (M0-14 AC). */
describe.skipIf(process.platform === 'win32')('hook.cjs end to end', () => {
  let base: string;
  let env: Record<string, string | undefined>;
  let cwd: string;

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'remotectl-hook-')));
    cwd = join(base, 'project');
    await mkdir(cwd, { recursive: true });
    env = {
      PATH: process.env['PATH'],
      HOME: join(base, 'home'),
      CLAUDE_CONFIG_DIR: join(base, 'claude'),
    };
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  function container() {
    return createContainer({
      platform: 'linux',
      env,
      homedir: join(base, 'home'),
      tmpdir: join(base, 'tmp'),
      output: { stdout: () => undefined, stderr: () => undefined },
      hookSource: HOOK_BUNDLE,
    });
  }

  it('prints nothing and exits 0 when no agent is running', async () => {
    const child = spawn(process.execPath, [HOOK_BUNDLE, '30'], {
      env: { PATH: process.env['PATH'] },
      stdio: 'pipe',
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once('close', resolve));
    child.stdin.end(JSON.stringify({ hook_event_name: 'Stop', session_id: 's' }));
    expect(await exited).toBe(0);
    expect(output).toBe('');
  });

  it('holds a PermissionRequest 5 s and delivers allow; an expired request is a handoff', async () => {
    const c = container();
    const signal = new AbortController().signal;
    expect(await runCli(['hooks', 'install'], c, { signal })).toBe(0);

    const store = createPendingStore({ clock: c.clock, timer: c.timer, random: c.random });
    const receiver = await c.startHookReceiver({
      port: 0,
      token: 'e2e-token',
      handler: createHookDispatcher({ store }),
      defaultHookTimeoutMs: 1_800_000,
    });
    try {
      await c.keyStore.publishHookEndpoint({ port: receiver.port, token: 'e2e-token' });
      const settings = loadHooks({ env, cwd });
      const runner = new HookRunner({ settings, cwd, env, clock: c.clock });
      // The same installed hooks with T = 12 s: the store answers {} at T - 10 s.
      const short = new HookRunner({
        settings: {
          ...settings,
          groups: Object.fromEntries(
            Object.entries(settings.groups).map(([event, groups]) => [
              event,
              groups.map((group) => ({
                ...group,
                hooks: group.hooks.map((hook) => ({
                  ...hook,
                  command: hook.command.replace(/ \d+$/, ' 12'),
                  timeout: 12,
                })),
              })),
            ]),
          ),
        },
        cwd,
        env,
        clock: c.clock,
      });
      const ctx = {
        sessionId: '0b6c4c1e-2f5d-4a8e-9a43-6c1f3f0d2a11',
        transcriptPath: join(base, 'transcript.jsonl'),
        cwd,
        permissionMode: 'default',
      };

      const feed = await runner.fire(
        'Stop',
        stopPayload(ctx, { stopHookActive: false, lastAssistantMessage: 'done' }),
      );
      expect(feed.decision).toBe('none');
      expect(feed.outcomes.map((outcome) => [outcome.status, outcome.stdout])).toEqual([
        ['ok', ''],
      ]);

      const allow = {
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
      };
      const started = performance.now();
      const timer = setTimeout(() => {
        const [pending] = store.list();
        if (pending !== undefined) store.resolve(pending.id, allow);
      }, 5_000);
      const decided = await runner.fire(
        'PermissionRequest',
        permissionRequestPayload(ctx, { toolName: 'Bash', toolInput: { command: 'ls' } }),
      );
      clearTimeout(timer);
      expect(performance.now() - started).toBeGreaterThanOrEqual(4_900);
      expect(decided.decision).toBe('allow');
      expect(JSON.parse(decided.outcomes[0]!.stdout)).toEqual(allow);

      const expired = await short.fire(
        'PermissionRequest',
        permissionRequestPayload(ctx, { toolName: 'Bash', toolInput: { command: 'rm x' } }),
      );
      expect(expired.decision).toBe('none');
      expect(expired.outcomes.map((outcome) => [outcome.status, outcome.stdout])).toEqual([
        ['ok', '{}'],
      ]);
      expect(store.list()).toEqual([]);
    } finally {
      store.releaseAll('shutdown');
      await receiver.close();
    }
  }, 30_000);
});
