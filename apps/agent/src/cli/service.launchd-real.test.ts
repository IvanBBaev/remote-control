import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemLaunchctl } from '../adapters/launchd/launchctl.js';
import { createContainer, type Container } from '../container.js';
import { EXIT_OK, runCli } from './main.js';
import { LAUNCHD_LABEL, launchdPlistPath } from './service.js';

/**
 * Real launchd round trip for the `agent-os` macOS CI job (M0-25). Skipped unless
 * `RC_TEST_REAL_LAUNCHCTL=1` on macOS: it bootstraps a real `dev.remotectl.agent` job (a
 * stand-in script, plist under a temp HOME) and must not run where the agent is installed.
 */
const enabled = process.platform === 'darwin' && process.env['RC_TEST_REAL_LAUNCHCTL'] === '1';

describe.skipIf(!enabled)('launchd service against the real launchctl', () => {
  let base: string;
  let c: Container;
  let stdout = '';
  const target = `gui/${process.getuid?.()}/${LAUNCHD_LABEL}`;

  beforeAll(async () => {
    expect((await systemLaunchctl.print(target)).code, `${target} is already loaded`).not.toBe(0);
    base = await realpath(await mkdtemp(join(tmpdir(), 'remotectl-launchd-')));
    const dist = join(base, 'global', 'node_modules', 'remotectl', 'dist');
    await mkdir(dist, { recursive: true });
    const script = join(dist, 'cli.mjs');
    await writeFile(script, 'setInterval(() => {}, 60_000);\n');
    c = createContainer({
      platform: 'darwin',
      env: { PATH: '/usr/bin:/bin', REMOTECTL_NO_UPDATE_CHECK: '1' },
      homedir: join(base, 'home'),
      tmpdir: join(base, 'tmp'),
      output: { stdout: (text) => (stdout += text), stderr: (text) => (stdout += text) },
      execPath: process.execPath,
      scriptPath: script,
      launchctl: systemLaunchctl,
    });
  });

  afterAll(async () => {
    await systemLaunchctl.bootout(target);
    await rm(base, { recursive: true, force: true });
  });

  const run = (argv: readonly string[]): Promise<number> =>
    runCli(argv, c, { signal: new AbortController().signal });

  it('installs, stays idempotent, reports running, and uninstalls', async () => {
    expect(await run(['install']), stdout).toBe(EXIT_OK);
    expect(await run(['install']), stdout).toBe(EXIT_OK);
    expect(stdout).toContain('already installed and loaded');
    let running = false;
    for (let i = 0; i < 50 && !running; i += 1) {
      stdout = '';
      await run(['status']);
      running = /service: +loaded, running \(pid \d+/.test(stdout);
      if (!running) await delay(100);
    }
    expect(running, stdout).toBe(true);
    expect(await run(['uninstall']), stdout).toBe(EXIT_OK);
    expect((await systemLaunchctl.print(target)).code).not.toBe(0);
    await expect(stat(launchdPlistPath(c))).rejects.toThrow();
  });
});
