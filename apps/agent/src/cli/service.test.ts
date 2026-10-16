import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createContainer, type Container } from '../container.js';
import type { Launchctl, LaunchctlResult } from '../ports/launchctl.js';
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, runCli } from './main.js';
import { LAUNCHD_LABEL, launchdPlistPath } from './service.js';

const darwinOnly = process.platform === 'darwin' ? it : it.skip;
const UID = 501;
const TARGET = `gui/${UID}/${LAUNCHD_LABEL}`;
const NODE = '/opt/node 22/bin/node';

/** An in-memory launchd: `bootstrap` loads a plist that exists on disk, `bootout` unloads. */
class FakeLaunchctl implements Launchctl {
  loaded = false;
  readonly calls: string[] = [];
  bootstrapResult: LaunchctlResult | undefined;
  bootoutResult: LaunchctlResult | undefined;
  printStdout = '\tstate = running\n\tpid = 4242\n\tlast exit code = (never exited)\n';

  async bootstrap(domain: string, plistPath: string): Promise<LaunchctlResult> {
    this.calls.push(`bootstrap ${domain} ${plistPath}`);
    if (this.bootstrapResult !== undefined) return this.bootstrapResult;
    await stat(plistPath);
    this.loaded = true;
    return { code: 0, stdout: '', stderr: '' };
  }

  bootout(serviceTarget: string): Promise<LaunchctlResult> {
    this.calls.push(`bootout ${serviceTarget}`);
    if (this.bootoutResult !== undefined) return Promise.resolve(this.bootoutResult);
    this.loaded = false;
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }

  print(serviceTarget: string): Promise<LaunchctlResult> {
    expect(serviceTarget).toBe(TARGET);
    return Promise.resolve(
      this.loaded
        ? { code: 0, stdout: this.printStdout, stderr: '' }
        : { code: 113, stdout: '', stderr: 'Could not find service' },
    );
  }
}

// The suite runs the darwin code on the host's real temp directory, so it needs POSIX paths;
// Windows hosts cover their own service in service-windows.test.ts.
const describePosix = describe.skipIf(process.platform === 'win32');

describePosix('remotectl install / uninstall / status (launchd)', () => {
  let base: string;
  let home: string;
  let script: string;
  let launchctl: FakeLaunchctl;
  let stdout: string;
  let stderr: string;

  function container(overrides: Partial<Parameters<typeof createContainer>[0]> = {}): Container {
    return createContainer({
      platform: 'darwin',
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', REMOTECTL_NO_UPDATE_CHECK: '1' },
      homedir: home,
      tmpdir: join(base, 'tmp'),
      output: { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) },
      clock: { now: () => 1_760_000_000_000 },
      uid: UID,
      execPath: NODE,
      scriptPath: script,
      launchctl,
      ...overrides,
    });
  }

  async function run(argv: readonly string[], c = container()): Promise<number> {
    return runCli(argv, c, { signal: new AbortController().signal });
  }

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'remotectl-svc-')));
    // A home with characters that need XML escaping; the real home is never touched.
    home = join(base, 'Tom & <Jerry> home');
    const dist = join(base, 'global lib', 'node_modules', 'remotectl', 'dist');
    await mkdir(dist, { recursive: true });
    script = join(dist, 'cli.mjs');
    await writeFile(script, '// bundle\n');
    launchctl = new FakeLaunchctl();
    stdout = '';
    stderr = '';
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('install --dry-run prints the plist and touches nothing', async () => {
    const c = container();
    expect(await run(['install', '--dry-run'], c)).toBe(EXIT_OK);
    expect(stdout).toContain('<key>Label</key>\n\t<string>dev.remotectl.agent</string>');
    expect(stdout).toContain(`<string>${NODE}</string>`);
    expect(stdout).toContain('<key>KeepAlive</key>\n\t<true/>');
    expect(stdout).toContain('<key>RunAtLoad</key>\n\t<true/>');
    const escapedLogs = join(home, 'Library', 'Logs', 'remotectl')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
    expect(stdout).toContain(`<string>${escapedLogs}/launchd.out.log</string>`);
    expect(stdout).toContain(`<string>${escapedLogs}/launchd.err.log</string>`);
    expect(stdout).toContain('<string>/opt/node 22/bin:/usr/local/bin:/usr/bin:/bin</string>');
    expect(launchctl.calls).toEqual([]);
    await expect(stat(launchdPlistPath(c))).rejects.toThrow();
  });

  it('installs, is idempotent, shows status, and uninstalls cleanly', async () => {
    const c = container();
    const plistPath = launchdPlistPath(c);
    expect(plistPath).toBe(join(home, 'Library', 'LaunchAgents', 'dev.remotectl.agent.plist'));

    expect(await run(['install'], c)).toBe(EXIT_OK);
    expect(stdout).toContain(`Installed ${plistPath}`);
    expect(launchctl.calls).toEqual([`bootstrap gui/${UID} ${plistPath}`]);
    const first = await readFile(plistPath, 'utf8');
    expect(first).toContain(`<string>${script.replaceAll('&', '&amp;')}</string>`);
    expect((await stat(plistPath)).mode & 0o777).toBe(0o644);
    expect((await stat(c.paths.log)).isDirectory()).toBe(true);

    // The dry run and the installed file agree.
    stdout = '';
    await run(['install', '--dry-run'], c);
    expect(stdout).toBe(first);

    stdout = '';
    expect(await run(['install'], c)).toBe(EXIT_OK);
    expect(stdout).toContain('already installed and loaded');
    expect(launchctl.calls).toHaveLength(1);
    expect(await readFile(plistPath, 'utf8')).toBe(first);

    stdout = '';
    expect(await run(['status'], c)).toBe(EXIT_OK);
    expect(stdout).toContain(
      'service:         loaded, running (pid 4242, last exit (never exited))',
    );

    stdout = '';
    expect(await run(['uninstall'], c)).toBe(EXIT_OK);
    expect(stdout).toContain(`removed ${plistPath}`);
    expect(launchctl.calls.at(-1)).toBe(`bootout ${TARGET}`);
    expect(launchctl.loaded).toBe(false);
    await expect(stat(plistPath)).rejects.toThrow();

    stdout = '';
    expect(await run(['uninstall'], c)).toBe(EXIT_OK);
    expect(stdout).toBe('remotectl is not installed as a service.\n');
    stdout = '';
    await run(['status'], c);
    expect(stdout).toContain('service:         not installed');
  });

  darwinOnly('writes a plist that plutil parses back to the same values', async () => {
    const c = container();
    expect(await run(['install'], c)).toBe(EXIT_OK);
    const { stdout: json } = await promisify(execFile)('/usr/bin/plutil', [
      '-convert',
      'json',
      '-o',
      '-',
      launchdPlistPath(c),
    ]);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      Label: LAUNCHD_LABEL,
      ProgramArguments: [NODE, script, 'run'],
      EnvironmentVariables: { HOME: home },
      RunAtLoad: true,
      KeepAlive: true,
      ThrottleInterval: 10,
      StandardOutPath: join(c.paths.log, 'launchd.out.log'),
      StandardErrorPath: join(c.paths.log, 'launchd.err.log'),
    });
  });

  it('reloads a changed definition and re-bootstraps an unloaded one', async () => {
    expect(await run(['install'])).toBe(EXIT_OK);
    const plistPath = launchdPlistPath(container());
    // A new Node binary changes the plist: bootout, rewrite, bootstrap.
    expect(await run(['install'], container({ execPath: '/opt/node 24/bin/node' }))).toBe(EXIT_OK);
    expect(launchctl.calls.slice(1)).toEqual([
      `bootout ${TARGET}`,
      `bootstrap gui/${UID} ${plistPath}`,
    ]);
    expect(await readFile(plistPath, 'utf8')).toContain('/opt/node 24/bin/node');

    // Same file but unloaded (e.g. after a manual bootout): bootstrap again only.
    launchctl.loaded = false;
    stdout = '';
    await run(['status'], container({ execPath: '/opt/node 24/bin/node' }));
    expect(stdout).toContain('service:         installed, not loaded');
    expect(await run(['install'], container({ execPath: '/opt/node 24/bin/node' }))).toBe(EXIT_OK);
    expect(launchctl.calls.at(-1)).toBe(`bootstrap gui/${UID} ${plistPath}`);
    expect(launchctl.calls.filter((call) => call.startsWith('bootout'))).toHaveLength(1);
  });

  it('resolves a bin symlink to the real package file', async () => {
    const bin = join(base, 'bin');
    await mkdir(bin);
    await symlink(script, join(bin, 'remotectl'));
    expect(
      await run(['install', '--dry-run'], container({ scriptPath: join(bin, 'remotectl') })),
    ).toBe(EXIT_OK);
    expect(stdout).toContain(`<string>${script.replaceAll('&', '&amp;')}</string>`);
  });

  it('refuses the npx cache and tells the user to install globally first', async () => {
    const npx = join(base, '.npm', '_npx', '0a1b2c', 'node_modules', 'remotectl', 'dist');
    await mkdir(npx, { recursive: true });
    await writeFile(join(npx, 'cli.mjs'), '// bundle\n');
    for (const argv of [['install'], ['install', '--dry-run']]) {
      stderr = '';
      expect(await run(argv, container({ scriptPath: join(npx, 'cli.mjs') }))).toBe(EXIT_ERROR);
      expect(stderr).toContain('it is running from the npx cache');
      expect(stderr).toContain('npm install -g remotectl');
    }
    expect(launchctl.calls).toEqual([]);
  });

  it('refuses an entry script that does not exist', async () => {
    expect(await run(['install'], container({ scriptPath: join(base, 'gone.mjs') }))).toBe(
      EXIT_ERROR,
    );
    expect(stderr).toContain('cannot locate the remotectl entry script');
  });

  it('reports a failing bootstrap and keeps the written plist', async () => {
    launchctl.bootstrapResult = { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: I/O error\n' };
    const c = container();
    expect(await run(['install'], c)).toBe(EXIT_ERROR);
    expect(stderr).toContain('launchctl bootstrap failed (exit 5): Bootstrap failed: 5: I/O error');
    expect((await stat(launchdPlistPath(c))).isFile()).toBe(true);
  });

  it('reports a failing bootout on reinstall and uninstall', async () => {
    expect(await run(['install'])).toBe(EXIT_OK);
    launchctl.bootoutResult = { code: 1, stdout: '', stderr: 'Boot-out failed\n' };
    expect(await run(['install'], container({ execPath: '/other/node' }))).toBe(EXIT_ERROR);
    expect(stderr).toContain('remotectl install: launchctl bootout failed: Boot-out failed');
    expect(await run(['uninstall'])).toBe(EXIT_ERROR);
    expect(stderr).toContain('remotectl uninstall: launchctl bootout failed');
  });

  it('describes a loaded service without a plist on disk', async () => {
    launchctl.loaded = true;
    launchctl.printStdout = 'gui/501/dev.remotectl.agent = {\n\tactive count = 0\n}\n';
    await run(['status']);
    expect(stdout).toContain('service:         loaded, unknown — plist missing');
    stdout = '';
    expect(await run(['uninstall'])).toBe(EXIT_OK);
    expect(stdout).toBe('Uninstalled the service.\n');
  });

  it('uninstall --dry-run prints the plan and touches nothing', async () => {
    const c = container();
    expect(await run(['install'], c)).toBe(EXIT_OK);
    stdout = '';
    expect(await run(['uninstall', '--dry-run'], c)).toBe(EXIT_OK);
    expect(stdout).toBe(
      `Would run: launchctl bootout ${TARGET} (if loaded)\nWould remove: ${launchdPlistPath(c)}\n`,
    );
    expect(launchctl.calls).toHaveLength(1);
    expect(launchctl.loaded).toBe(true);
    expect((await stat(launchdPlistPath(c))).isFile()).toBe(true);
  });

  it('rejects unknown options', async () => {
    expect(await run(['install', '--force'])).toBe(EXIT_USAGE);
    expect(await run(['uninstall', 'now'])).toBe(EXIT_USAGE);
    expect(await run(['uninstall', '--force'])).toBe(EXIT_USAGE);
  });

  it('says not supported on another platform and exits 1', async () => {
    for (const command of ['install', 'uninstall']) {
      stderr = '';
      expect(await run([command], container({ platform: 'freebsd' }))).toBe(EXIT_ERROR);
      expect(stderr).toContain('running as a service is not supported on freebsd');
    }
    stdout = '';
    expect(await run(['status'], container({ platform: 'freebsd' }))).toBe(EXIT_OK);
    expect(stdout).toContain('service:         not supported on freebsd\n');
    expect(stdout).toContain('update:          check disabled\n');
    expect(launchctl.calls).toEqual([]);
  });
});
