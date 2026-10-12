import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const run = promisify(execFile);
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const BUNDLE = join(PACKAGE_DIR, 'dist', 'cli.mjs');
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

/** AC: the published package is one bundled file with no runtime dependency (D22, R13). */
describe('npm package', () => {
  let home: string;

  beforeAll(async () => {
    await run('pnpm', ['run', 'build'], { cwd: PACKAGE_DIR });
    home = await mkdtemp(join(tmpdir(), 'remotectl-pack-'));
  }, 120_000);

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

  it('packs only the bundle, its source map and package.json', async () => {
    const { stdout } = await run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: PACKAGE_DIR,
    });
    const [packed] = JSON.parse(stdout) as [{ files: PackFile[]; bundled: string[] }];
    expect(packed.files.map((file) => file.path).sort()).toEqual([
      'dist/cli.mjs',
      'dist/cli.mjs.map',
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

  it('runs: --help lists the commands', async () => {
    const { stdout } = await run(process.execPath, [BUNDLE, '--help']);
    for (const command of ['run', 'status', 'pair', 'devices', 'hooks install', 'logs']) {
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
      };
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
