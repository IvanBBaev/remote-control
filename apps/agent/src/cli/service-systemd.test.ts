import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createContainer, type Container } from '../container.js';
import type { ProcessResult } from '../ports/process-result.js';
import type { Systemctl } from '../ports/systemctl.js';
import { EXIT_ERROR, EXIT_OK, runCli } from './main.js';
import { SYSTEMD_UNIT, systemdUnitPath } from './service.js';

const UID = 1000;
const NODE = '/opt/node 22/bin/node';

type Failure = ProcessResult | NodeJS.ErrnoException;

/**
 * An in-memory user manager: a unit is loaded while its file exists (or `loadedWithoutFile`),
 * `enable --now` enables and starts it, `disable --now` undoes both.
 */
class FakeSystemctl implements Systemctl {
  readonly calls: string[] = [];
  enabled = false;
  active = false;
  linger = false;
  loadedWithoutFile = false;
  readonly failures: Partial<Record<keyof Systemctl, Failure>> = {};

  constructor(private readonly unitPath: () => string) {}

  private async answer(
    method: keyof Systemctl,
    call: string,
    effect: () => Promise<string> | string = () => '',
  ): Promise<ProcessResult> {
    this.calls.push(call);
    const failure = this.failures[method];
    if (failure instanceof Error) throw failure;
    if (failure !== undefined) return failure;
    return { code: 0, stdout: await effect(), stderr: '' };
  }

  private async fileExists(): Promise<boolean> {
    return stat(this.unitPath()).then(
      () => true,
      () => false,
    );
  }

  daemonReload(): Promise<ProcessResult> {
    return this.answer('daemonReload', 'daemon-reload');
  }

  async enableNow(unit: string): Promise<ProcessResult> {
    expect(unit).toBe(SYSTEMD_UNIT);
    if (!(await this.fileExists())) {
      return { code: 1, stdout: '', stderr: `Unit file ${unit} does not exist.\n` };
    }
    return this.answer('enableNow', `enable --now ${unit}`, () => {
      this.enabled = true;
      this.active = true;
      return '';
    });
  }

  disableNow(unit: string): Promise<ProcessResult> {
    return this.answer('disableNow', `disable --now ${unit}`, () => {
      this.enabled = false;
      this.active = false;
      return '';
    });
  }

  restart(unit: string): Promise<ProcessResult> {
    return this.answer('restart', `restart ${unit}`);
  }

  show(unit: string): Promise<ProcessResult> {
    expect(unit).toBe(SYSTEMD_UNIT);
    return this.answer('show', 'show', async () =>
      this.loadedWithoutFile || (await this.fileExists())
        ? [
            'LoadState=loaded',
            `ActiveState=${this.active ? 'active' : 'inactive'}`,
            `SubState=${this.active ? 'running' : 'dead'}`,
            `MainPID=${this.active ? 4242 : 0}`,
            'ExecMainStatus=0',
            `UnitFileState=${this.enabled ? 'enabled' : 'disabled'}`,
            '',
          ].join('\n')
        : 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\nUnitFileState=\n',
    );
  }

  enableLinger(): Promise<ProcessResult> {
    return this.answer('enableLinger', 'enable-linger', () => {
      this.linger = true;
      return '';
    });
  }

  showLinger(uid: number): Promise<ProcessResult> {
    expect(uid).toBe(UID);
    return this.answer('showLinger', 'show-linger', () => `Linger=${this.linger ? 'yes' : 'no'}\n`);
  }
}

describe('remotectl install / uninstall / status (systemd --user)', () => {
  let base: string;
  let home: string;
  let script: string;
  let systemctl: FakeSystemctl;
  let stdout: string;
  let stderr: string;

  function container(overrides: Partial<Parameters<typeof createContainer>[0]> = {}): Container {
    return createContainer({
      platform: 'linux',
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', REMOTECTL_NO_UPDATE_CHECK: '1' },
      homedir: home,
      tmpdir: join(base, 'tmp'),
      output: { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) },
      clock: { now: () => 1_760_000_000_000 },
      uid: UID,
      execPath: NODE,
      scriptPath: script,
      systemctl,
      ...overrides,
    });
  }

  async function run(argv: readonly string[], c = container()): Promise<number> {
    return runCli(argv, c, { signal: new AbortController().signal });
  }

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'remotectl-systemd-')));
    // A home with characters the unit file must quote; the real home is never touched.
    home = join(base, 'Tom "50%" $HOME');
    const dist = join(base, 'global lib', 'node_modules', 'remotectl', 'dist');
    await mkdir(dist, { recursive: true });
    script = join(dist, 'cli.mjs');
    await writeFile(script, '// bundle\n');
    systemctl = new FakeSystemctl(() => systemdUnitPath(container()));
    stdout = '';
    stderr = '';
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('install --dry-run prints the unit and touches nothing', async () => {
    const c = container();
    expect(await run(['install', '--dry-run'], c)).toBe(EXIT_OK);
    expect(stdout).toContain(`ExecStart="${NODE}" "${script}" "run"\n`);
    expect(stdout).toContain(
      `Environment="HOME=${home.replaceAll('"', '\\"').replaceAll('%', '%%')}" ` +
        '"PATH=/opt/node 22/bin:/usr/local/bin:/usr/bin:/bin"\n',
    );
    expect(stdout).toContain('Restart=always\n');
    expect(stdout).toContain('WantedBy=default.target\n');
    expect(systemctl.calls).toEqual([]);
    await expect(stat(systemdUnitPath(c))).rejects.toThrow();
  });

  it('installs, is idempotent, shows status, and uninstalls cleanly (twice)', async () => {
    const c = container();
    const unitPath = systemdUnitPath(c);
    expect(unitPath).toBe(join(home, '.config', 'systemd', 'user', 'remotectl.service'));

    expect(await run(['install'], c)).toBe(EXIT_OK);
    expect(stdout).toContain(`Installed ${unitPath}`);
    expect(stdout).toContain('journalctl --user -u remotectl');
    expect(stdout).toContain('Enabled lingering');
    expect(systemctl.calls).toEqual([
      'show',
      'daemon-reload',
      `enable --now ${SYSTEMD_UNIT}`,
      'show-linger',
      'enable-linger',
    ]);
    const first = await readFile(unitPath, 'utf8');
    expect((await stat(unitPath)).mode & 0o777).toBe(0o644);

    // The dry run and the installed file agree.
    stdout = '';
    await run(['install', '--dry-run'], c);
    expect(stdout).toBe(first);

    systemctl.calls.length = 0;
    stdout = '';
    expect(await run(['install'], c)).toBe(EXIT_OK);
    expect(stdout).toBe(`remotectl is already installed and running (${unitPath}).\n`);
    expect(systemctl.calls).toEqual(['show', 'show-linger']);
    expect(await readFile(unitPath, 'utf8')).toBe(first);

    stdout = '';
    expect(await run(['status'], c)).toBe(EXIT_OK);
    expect(stdout).toContain(
      'service:         loaded, active/running (pid 4242, last exit 0, enabled)\n',
    );

    systemctl.calls.length = 0;
    stdout = '';
    expect(await run(['uninstall'], c)).toBe(EXIT_OK);
    expect(stdout).toContain(`Uninstalled the service and removed ${unitPath}.`);
    expect(stdout).toContain('Lingering stays enabled');
    expect(systemctl.calls).toEqual(['show', `disable --now ${SYSTEMD_UNIT}`, 'daemon-reload']);
    expect(systemctl.linger).toBe(true);
    await expect(stat(unitPath)).rejects.toThrow();

    stdout = '';
    expect(await run(['uninstall'], c)).toBe(EXIT_OK);
    expect(stdout).toBe('remotectl is not installed as a service.\n');
    stdout = '';
    await run(['status'], c);
    expect(stdout).toContain('service:         not installed (`remotectl install`)\n');
  });

  it('uses $XDG_CONFIG_HOME for the unit', () => {
    const xdg = join(base, 'xdg');
    const c = container({
      env: { PATH: '/usr/bin:/bin', XDG_CONFIG_HOME: xdg, REMOTECTL_NO_UPDATE_CHECK: '1' },
    });
    expect(systemdUnitPath(c)).toBe(join(xdg, 'systemd', 'user', 'remotectl.service'));
  });

  it('restarts a running unit whose definition changed, but not an unchanged one', async () => {
    expect(await run(['install'])).toBe(EXIT_OK);
    const unitPath = systemdUnitPath(container());
    const other = container({ execPath: '/opt/node 24/bin/node' });
    systemctl.calls.length = 0;
    expect(await run(['install'], other)).toBe(EXIT_OK);
    expect(systemctl.calls).toEqual([
      'show',
      'daemon-reload',
      `enable --now ${SYSTEMD_UNIT}`,
      `restart ${SYSTEMD_UNIT}`,
      'show-linger',
    ]);
    expect(await readFile(unitPath, 'utf8')).toContain('/opt/node 24/bin/node');

    // Same file but stopped (e.g. after `systemctl --user stop`): enable --now only.
    systemctl.active = false;
    stdout = '';
    await run(['status'], other);
    expect(stdout).toContain('service:         loaded, inactive/dead (last exit 0, enabled)\n');
    systemctl.calls.length = 0;
    expect(await run(['install'], other)).toBe(EXIT_OK);
    expect(systemctl.calls).toEqual([
      'show',
      'daemon-reload',
      `enable --now ${SYSTEMD_UNIT}`,
      'show-linger',
    ]);
  });

  it('warns when lingering cannot be enabled and still succeeds', async () => {
    systemctl.failures.enableLinger = {
      code: 1,
      stdout: '',
      stderr: 'Could not enable linger: Access denied\n',
    };
    expect(await run(['install'])).toBe(EXIT_OK);
    expect(stderr).toContain('could not enable lingering (Could not enable linger: Access denied)');
    expect(stderr).toContain('loginctl enable-linger $USER');
    expect(stdout).toContain('Installed');
  });

  it('uninstall --dry-run prints the plan and touches nothing', async () => {
    const c = container();
    expect(await run(['install'], c)).toBe(EXIT_OK);
    systemctl.calls.length = 0;
    stdout = '';
    expect(await run(['uninstall', '--dry-run'], c)).toBe(EXIT_OK);
    expect(stdout).toBe(
      `Would run: systemctl --user disable --now ${SYSTEMD_UNIT} (if loaded)\n` +
        `Would remove: ${systemdUnitPath(c)}\nWould run: systemctl --user daemon-reload\n`,
    );
    expect(systemctl.calls).toEqual([]);
    expect((await stat(systemdUnitPath(c))).isFile()).toBe(true);
  });

  it('describes a loaded unit without a file and an unloaded file', async () => {
    systemctl.loadedWithoutFile = true;
    systemctl.active = true;
    await run(['status']);
    expect(stdout).toContain(
      'service:         loaded, active/running (pid 4242, last exit 0, disabled) — unit file missing\n',
    );
    stdout = '';
    expect(await run(['uninstall'])).toBe(EXIT_OK);
    expect(stdout).toContain('Uninstalled the service.\n');

    systemctl.loadedWithoutFile = false;
    systemctl.failures.show = { code: 0, stdout: 'LoadState=not-found\n', stderr: '' };
    const c = container();
    await mkdir(join(c.service.xdgConfigHome, 'systemd', 'user'), { recursive: true });
    await writeFile(systemdUnitPath(c), '[Unit]\n');
    stdout = '';
    await run(['status'], c);
    expect(stdout).toContain(
      `service:         installed, not loaded (${systemdUnitPath(c)}; run \`remotectl install\`)\n`,
    );
  });

  it('reports a missing systemctl in install, uninstall and status', async () => {
    systemctl.failures.show = Object.assign(new Error('spawn /usr/bin/systemctl ENOENT'), {
      code: 'ENOENT',
    });
    expect(await run(['install'])).toBe(EXIT_ERROR);
    expect(stderr).toContain(
      'remotectl install: systemctl --user show failed: spawn /usr/bin/systemctl ENOENT',
    );
    expect(await run(['uninstall'])).toBe(EXIT_ERROR);
    expect(stderr).toContain('remotectl uninstall: systemctl --user show failed');
    expect(await run(['status'])).toBe(EXIT_OK);
    expect(stdout).toContain(
      'service:         unknown (systemctl --user: spawn /usr/bin/systemctl ENOENT)\n',
    );
  });

  it('rethrows an unexpected error from the service manager', async () => {
    systemctl.failures.show = new Error('bug');
    await expect(run(['install'])).rejects.toThrow('bug');
  });

  it.each([
    ['daemonReload', 'systemctl --user daemon-reload failed: Failed to connect to bus'],
    ['enableNow', 'systemctl --user enable --now failed: Failed to connect to bus'],
  ] as const)('reports a failing %s on install', async (method, message) => {
    systemctl.failures[method] = { code: 1, stdout: '', stderr: 'Failed to connect to bus\n' };
    expect(await run(['install'])).toBe(EXIT_ERROR);
    expect(stderr).toContain(`remotectl install: ${message}`);
  });

  it('reports a failing restart, disable and reload', async () => {
    expect(await run(['install'])).toBe(EXIT_OK);
    systemctl.failures.restart = { code: 1, stdout: 'Job failed', stderr: '' };
    expect(await run(['install'], container({ execPath: '/other/node' }))).toBe(EXIT_ERROR);
    expect(stderr).toContain('remotectl install: systemctl --user restart failed: Job failed');

    systemctl.failures.disableNow = { code: 1, stdout: '', stderr: '' };
    expect(await run(['uninstall'])).toBe(EXIT_ERROR);
    expect(stderr).toContain('remotectl uninstall: systemctl --user disable --now failed: exit 1');

    delete systemctl.failures.disableNow;
    systemctl.failures.daemonReload = { code: 1, stdout: '', stderr: 'reload failed\n' };
    expect(await run(['uninstall'])).toBe(EXIT_ERROR);
    expect(stderr).toContain('remotectl uninstall: systemctl --user daemon-reload failed');
  });

  it('refuses without a user id, from the npx cache and with a missing script', async () => {
    const plain = container();
    const noUid: Container = { ...plain, service: { ...plain.service, uid: undefined } };
    expect(await run(['install'], noUid)).toBe(EXIT_ERROR);
    expect(stderr).toContain('remotectl install: cannot determine the user id.');

    const npx = join(base, '.npm', '_npx', '0a1b2c', 'node_modules', 'remotectl', 'dist');
    await mkdir(npx, { recursive: true });
    await writeFile(join(npx, 'cli.mjs'), '// bundle\n');
    for (const argv of [['install'], ['install', '--dry-run']]) {
      stderr = '';
      expect(await run(argv, container({ scriptPath: join(npx, 'cli.mjs') }))).toBe(EXIT_ERROR);
      expect(stderr).toContain('it is running from the npx cache');
      expect(stderr).toContain('npm install -g remotectl');
    }
    expect(await run(['install'], container({ scriptPath: join(base, 'gone.mjs') }))).toBe(
      EXIT_ERROR,
    );
    expect(stderr).toContain('cannot locate the remotectl entry script');
    expect(systemctl.calls).toEqual([]);
  });
});
