import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemSystemctl } from '../adapters/systemd/systemctl.js';
import { createContainer, type Container } from '../container.js';
import { EXIT_OK, runCli } from './main.js';
import { SYSTEMD_UNIT, systemdUnitPath } from './service.js';

/**
 * Real systemd --user round trip for a Linux CI job. Skipped unless
 * `RC_TEST_REAL_SYSTEMCTL=1` on Linux: the user manager only reads units from the real
 * `$XDG_CONFIG_HOME/systemd/user`, so this writes `remotectl.service` there (pointing at a
 * stand-in script under a temp directory), may enable lingering for the user, and must
 * not run where the agent is installed.
 */
const enabled = process.platform === 'linux' && process.env['RC_TEST_REAL_SYSTEMCTL'] === '1';

describe.skipIf(!enabled)('systemd service against the real systemctl', () => {
  let base: string;
  let c: Container;
  let stdout = '';

  beforeAll(async () => {
    const shown = await systemSystemctl.show(SYSTEMD_UNIT);
    expect(shown.stdout, `${SYSTEMD_UNIT} is already loaded`).toContain('LoadState=not-found');
    base = await realpath(await mkdtemp(join(tmpdir(), 'remotectl-systemd-')));
    const dist = join(base, 'global', 'node_modules', 'remotectl', 'dist');
    await mkdir(dist, { recursive: true });
    const script = join(dist, 'cli.mjs');
    await writeFile(script, 'setInterval(() => {}, 60_000);\n');
    const env: Record<string, string> = {
      PATH: '/usr/bin:/bin',
      REMOTECTL_NO_UPDATE_CHECK: '1',
    };
    const xdg = process.env['XDG_CONFIG_HOME'];
    if (xdg) env['XDG_CONFIG_HOME'] = xdg;
    c = createContainer({
      platform: 'linux',
      env,
      homedir: homedir(),
      tmpdir: join(base, 'tmp'),
      output: { stdout: (text) => (stdout += text), stderr: (text) => (stdout += text) },
      execPath: process.execPath,
      scriptPath: script,
      systemctl: systemSystemctl,
    });
    await expect(stat(systemdUnitPath(c)), 'a unit file is already there').rejects.toThrow();
  });

  afterAll(async () => {
    if (c !== undefined) await runCli(['uninstall'], c, { signal: new AbortController().signal });
    await rm(base, { recursive: true, force: true });
  });

  const run = (argv: readonly string[]): Promise<number> =>
    runCli(argv, c, { signal: new AbortController().signal });

  it('installs, stays idempotent, reports running, and uninstalls', async () => {
    expect(await run(['install']), stdout).toBe(EXIT_OK);
    expect(await run(['install']), stdout).toBe(EXIT_OK);
    let running = false;
    for (let i = 0; i < 50 && !running; i += 1) {
      stdout = '';
      await run(['status']);
      running = /service: +loaded, active\/running \(pid \d+/.test(stdout);
      if (!running) await delay(100);
    }
    expect(running, stdout).toBe(true);
    expect(await run(['uninstall']), stdout).toBe(EXIT_OK);
    expect((await systemSystemctl.show(SYSTEMD_UNIT)).stdout).toContain('LoadState=not-found');
    await expect(stat(systemdUnitPath(c))).rejects.toThrow();
  });
});
