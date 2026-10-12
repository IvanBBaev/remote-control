import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemSchtasks } from '../adapters/windows/schtasks.js';
import { createContainer, type Container } from '../container.js';
import { EXIT_OK, runCli } from './main.js';
import { WINDOWS_TASK, windowsTaskFiles } from './service.js';

/**
 * Real Task Scheduler round trip for a Windows CI job. Skipped unless
 * `RC_TEST_REAL_SCHTASKS=1` on Windows: it registers and starts a real `remotectl` task
 * (a stand-in script, task files under a temp LOCALAPPDATA) and must not run where the
 * agent is installed.
 */
const enabled = process.platform === 'win32' && process.env['RC_TEST_REAL_SCHTASKS'] === '1';

describe.skipIf(!enabled)('Task Scheduler service against the real schtasks', () => {
  let base: string;
  let c: Container;
  let stdout = '';

  beforeAll(async () => {
    expect((await systemSchtasks.query(WINDOWS_TASK)).code, 'the task already exists').not.toBe(0);
    base = await realpath(await mkdtemp(join(tmpdir(), 'remotectl-schtasks-')));
    const dist = join(base, 'global', 'node_modules', 'remotectl', 'dist');
    await mkdir(dist, { recursive: true });
    const script = join(dist, 'cli.mjs');
    await writeFile(script, 'setInterval(() => {}, 60_000);\n');
    c = createContainer({
      platform: 'win32',
      env: {
        LOCALAPPDATA: join(base, 'Local'),
        APPDATA: join(base, 'Roaming'),
        USERNAME: process.env['USERNAME'] ?? '',
        USERDOMAIN: process.env['USERDOMAIN'] ?? '',
        REMOTECTL_NO_UPDATE_CHECK: '1',
      },
      homedir: base,
      tmpdir: join(base, 'tmp'),
      output: { stdout: (text) => (stdout += text), stderr: (text) => (stdout += text) },
      execPath: process.execPath,
      scriptPath: script,
      schtasks: systemSchtasks,
    });
  });

  afterAll(async () => {
    await systemSchtasks.end(WINDOWS_TASK);
    await systemSchtasks.delete(WINDOWS_TASK);
    await rm(base, { recursive: true, force: true });
  });

  const run = (argv: readonly string[]): Promise<number> =>
    runCli(argv, c, { signal: new AbortController().signal });

  it('installs, stays idempotent, reports the task, and uninstalls', async () => {
    expect(await run(['install']), stdout).toBe(EXIT_OK);
    expect(await run(['install']), stdout).toBe(EXIT_OK);
    expect(stdout).toContain('already installed');
    stdout = '';
    await run(['status']);
    expect(stdout).toContain('service:         installed (scheduled task remotectl');
    expect(await run(['uninstall']), stdout).toBe(EXIT_OK);
    expect((await systemSchtasks.query(WINDOWS_TASK)).code).not.toBe(0);
    expect(await c.fs.readBytes(windowsTaskFiles(c).xmlPath)).toBeUndefined();
  });
});
