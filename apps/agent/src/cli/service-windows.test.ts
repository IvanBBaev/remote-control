import { win32 } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { createContainer, type Container } from '../container.js';
import { utf16le } from '../core/windows-task.js';
import type { FileSystem } from '../ports/file-system.js';
import type { PathPort } from '../ports/path-port.js';
import type { ProcessResult } from '../ports/process-result.js';
import type { Schtasks } from '../ports/schtasks.js';
import { EXIT_ERROR, EXIT_OK, runCli } from './main.js';
import { WINDOWS_TASK, windowsTaskFiles } from './service.js';

const LOCAL = 'C:\\Users\\Tom\\AppData\\Local';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const SCRIPT = 'C:\\Users\\Tom\\AppData\\Roaming\\npm\\node_modules\\remotectl\\dist\\cli.mjs';
const TEMP = 'C:\\Users\\Tom\\AppData\\Local\\Temp';

/** A Windows file system in memory, so the win32 code paths run on any host. */
class MemoryFileSystem implements FileSystem {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>();

  readText(path: string): Promise<string | undefined> {
    const bytes = this.files.get(path);
    return Promise.resolve(bytes === undefined ? undefined : new TextDecoder().decode(bytes));
  }

  writeTextAtomic(path: string, text: string): Promise<void> {
    this.files.set(path, new TextEncoder().encode(text));
    return Promise.resolve();
  }

  readBytes(path: string): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.files.get(path));
  }

  writeBytesAtomic(path: string, bytes: Uint8Array): Promise<void> {
    if (!this.dirs.has(win32.dirname(path))) {
      return Promise.reject(Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' }));
    }
    this.files.set(path, bytes);
    return Promise.resolve();
  }

  ensureDir(path: string): Promise<void> {
    this.dirs.add(path);
    return Promise.resolve();
  }

  permissions(path: string): Promise<number | undefined> {
    return Promise.resolve(this.files.has(path) ? 0o666 : undefined);
  }

  chmod(): Promise<void> {
    return Promise.resolve();
  }

  remove(path: string): Promise<boolean> {
    return Promise.resolve(this.files.delete(path));
  }
}

function windowsPaths(fs: MemoryFileSystem): PathPort {
  return {
    isAbsolute: (path) => win32.isAbsolute(path),
    realpath: (path) =>
      Promise.resolve(fs.files.has(path) || path === TEMP ? win32.resolve(path) : undefined),
    contains: (parent, child) => {
      const relative = win32.relative(parent, child);
      return relative === '' || (!relative.startsWith('..') && !win32.isAbsolute(relative));
    },
    join: (...parts) => win32.join(...parts),
  };
}

type Failure = ProcessResult | NodeJS.ErrnoException;

/** Task Scheduler in memory: `/Create` registers, `/Delete` unregisters. */
class FakeSchtasks implements Schtasks {
  readonly calls: string[] = [];
  registered = false;
  readonly failures: Partial<Record<keyof Schtasks, Failure>> = {};

  constructor(private readonly fs: MemoryFileSystem) {}

  private answer(method: keyof Schtasks, call: string, effect = (): void => {}): ProcessResult {
    this.calls.push(call);
    const failure = this.failures[method];
    if (failure instanceof Error) throw failure;
    if (failure !== undefined) return failure;
    effect();
    return { code: 0, stdout: '', stderr: '' };
  }

  create(task: string, xmlPath: string): Promise<ProcessResult> {
    expect(task).toBe(WINDOWS_TASK);
    expect(this.fs.files.has(xmlPath)).toBe(true);
    return Promise.resolve(this.answer('create', '/Create', () => (this.registered = true)));
  }

  delete(task: string): Promise<ProcessResult> {
    expect(task).toBe(WINDOWS_TASK);
    return Promise.resolve(this.answer('delete', '/Delete', () => (this.registered = false)));
  }

  query(task: string): Promise<ProcessResult> {
    expect(task).toBe(WINDOWS_TASK);
    this.calls.push('/Query');
    const failure = this.failures.query;
    if (failure instanceof Error) return Promise.reject(failure);
    return Promise.resolve(
      failure ??
        (this.registered
          ? { code: 0, stdout: '<Task/>', stderr: '' }
          : { code: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' }),
    );
  }

  run(): Promise<ProcessResult> {
    return Promise.resolve(this.answer('run', '/Run'));
  }

  end(): Promise<ProcessResult> {
    return Promise.resolve(this.answer('end', '/End'));
  }
}

describe('remotectl install / uninstall / status (Task Scheduler)', () => {
  let fs: MemoryFileSystem;
  let schtasks: FakeSchtasks;
  let stdout: string;
  let stderr: string;

  function container(
    overrides: Partial<Parameters<typeof createContainer>[0]> = {},
    env: Record<string, string> = { USERNAME: 'tom', USERDOMAIN: 'PC' },
  ): Container {
    return createContainer({
      platform: 'win32',
      env: {
        LOCALAPPDATA: LOCAL,
        APPDATA: 'C:\\Users\\Tom\\AppData\\Roaming',
        REMOTECTL_NO_UPDATE_CHECK: '1',
        ...env,
      },
      homedir: 'C:\\Users\\Tom',
      tmpdir: TEMP,
      output: { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) },
      clock: { now: () => 1_760_000_000_000 },
      execPath: NODE,
      scriptPath: SCRIPT,
      schtasks,
      fs,
      pathPort: windowsPaths(fs),
      ...overrides,
    });
  }

  const run = (argv: readonly string[], c = container()): Promise<number> =>
    runCli(argv, c, { signal: new AbortController().signal });

  beforeEach(() => {
    fs = new MemoryFileSystem();
    fs.files.set(SCRIPT, new TextEncoder().encode('// bundle\n'));
    schtasks = new FakeSchtasks(fs);
    stdout = '';
    stderr = '';
  });

  it('keeps the task files in the data directory', () => {
    expect(windowsTaskFiles(container())).toEqual({
      xmlPath: `${LOCAL}\\remotectl\\Data\\service-task.xml`,
      vbsPath: `${LOCAL}\\remotectl\\Data\\service.vbs`,
    });
  });

  it('install --dry-run prints the launcher and the task and touches nothing', async () => {
    const { xmlPath, vbsPath } = windowsTaskFiles(container());
    expect(await run(['install', '--dry-run'])).toBe(EXIT_OK);
    expect(stdout).toContain(`--- ${vbsPath}\n`);
    expect(stdout).toContain(`Run("""${NODE}"" ""${SCRIPT}"" ""run""", 0, True)\n`);
    expect(stdout).toContain(`--- ${xmlPath}\n`);
    expect(stdout).toContain('<UserId>PC\\tom</UserId>');
    expect(stdout).toContain(`&quot;${vbsPath}&quot;</Arguments>`);
    expect(stdout).not.toContain('\r');
    expect(schtasks.calls).toEqual([]);
    expect([...fs.files.keys()]).toEqual([SCRIPT]);
  });

  it('installs, is idempotent, shows status, and uninstalls cleanly (twice)', async () => {
    const c = container();
    const { xmlPath, vbsPath } = windowsTaskFiles(c);
    expect(await run(['install'], c)).toBe(EXIT_OK);
    expect(stdout).toBe(
      `Installed the scheduled task remotectl (${xmlPath}).\n` +
        'The agent now starts at logon and restarts if it fails.\n' +
        `Service output: ${LOCAL}\\remotectl\\Log\n`,
    );
    expect(schtasks.calls).toEqual(['/Query', '/Create', '/Run']);
    const xml = fs.files.get(xmlPath);
    const vbs = fs.files.get(vbsPath);
    expect([...(xml ?? []).slice(0, 2)]).toEqual([0xff, 0xfe]);
    expect([...(vbs ?? []).slice(0, 2)]).toEqual([0xff, 0xfe]);
    stdout = '';
    await run(['install', '--dry-run'], c);
    const printed = stdout.slice(stdout.indexOf(`--- ${xmlPath}\n`) + xmlPath.length + 5);
    expect(xml).toEqual(utf16le(printed));

    schtasks.calls.length = 0;
    stdout = '';
    expect(await run(['install'], c)).toBe(EXIT_OK);
    expect(stdout).toBe('remotectl is already installed (scheduled task remotectl).\n');
    expect(schtasks.calls).toEqual(['/Query']);

    stdout = '';
    expect(await run(['status'], c)).toBe(EXIT_OK);
    expect(stdout).toContain(
      'service:         installed (scheduled task remotectl, runs at logon)\n',
    );

    schtasks.calls.length = 0;
    stdout = '';
    expect(await run(['uninstall'], c)).toBe(EXIT_OK);
    expect(stdout).toBe(
      'Uninstalled the service (scheduled task remotectl) and removed its files.\n',
    );
    expect(schtasks.calls).toEqual(['/Query', '/End', '/Delete']);
    expect([...fs.files.keys()]).toEqual([SCRIPT]);

    stdout = '';
    expect(await run(['uninstall'], c)).toBe(EXIT_OK);
    expect(stdout).toBe('remotectl is not installed as a service.\n');
    stdout = '';
    await run(['status'], c);
    expect(stdout).toContain('service:         not installed (`remotectl install`)\n');
  });

  it('ends and re-registers a task whose definition changed', async () => {
    expect(await run(['install'])).toBe(EXIT_OK);
    const other = 'C:\\nodejs 24\\node.exe';
    schtasks.calls.length = 0;
    schtasks.failures.end = { code: 1, stdout: '', stderr: 'ERROR: The task is not running.' };
    expect(await run(['install'], container({ execPath: other }))).toBe(EXIT_OK);
    expect(schtasks.calls).toEqual(['/Query', '/End', '/Create', '/Run']);
    const { vbsPath } = windowsTaskFiles(container());
    expect(fs.files.get(vbsPath)).toEqual(
      utf16le(
        "' remotectl service launcher, written by `remotectl install`; do not edit.\r\n" +
          `WScript.Quit CreateObject("WScript.Shell").Run("""${other}"" ""${SCRIPT}"" ""run""", 0, True)\r\n`,
      ),
    );
  });

  it('re-registers when the files exist but the task does not', async () => {
    expect(await run(['install'])).toBe(EXIT_OK);
    schtasks.registered = false;
    stdout = '';
    await run(['status']);
    const { xmlPath } = windowsTaskFiles(container());
    expect(stdout).toContain(
      `service:         installed, not registered (${xmlPath}; run \`remotectl install\`)\n`,
    );
    schtasks.calls.length = 0;
    expect(await run(['install'])).toBe(EXIT_OK);
    expect(schtasks.calls).toEqual(['/Query', '/Create', '/Run']);
  });

  it('uninstall --dry-run prints the plan and touches nothing', async () => {
    expect(await run(['install'])).toBe(EXIT_OK);
    const { xmlPath, vbsPath } = windowsTaskFiles(container());
    schtasks.calls.length = 0;
    stdout = '';
    expect(await run(['uninstall', '--dry-run'])).toBe(EXIT_OK);
    expect(stdout).toBe(
      'Would run: schtasks /End and /Delete /TN remotectl (if registered)\n' +
        `Would remove: ${vbsPath}\nWould remove: ${xmlPath}\n`,
    );
    expect(schtasks.calls).toEqual([]);
    expect(fs.files.has(xmlPath)).toBe(true);
  });

  it('removes leftover files when the task is gone', async () => {
    expect(await run(['install'])).toBe(EXIT_OK);
    schtasks.registered = false;
    stdout = '';
    expect(await run(['uninstall'])).toBe(EXIT_OK);
    expect(stdout).toBe('Uninstalled the service and removed its files.\n');
  });

  it('reports failing /Create, /Run and /Delete', async () => {
    schtasks.failures.create = { code: 1, stdout: '', stderr: 'ERROR: Access is denied.\r\n' };
    expect(await run(['install'])).toBe(EXIT_ERROR);
    const { xmlPath } = windowsTaskFiles(container());
    expect(stderr).toContain(
      `remotectl install: wrote ${xmlPath}, but schtasks /Create failed: ERROR: Access is denied.`,
    );

    delete schtasks.failures.create;
    schtasks.failures.run = { code: 1, stdout: 'ERROR: busy', stderr: '' };
    expect(await run(['install'])).toBe(EXIT_ERROR);
    expect(stderr).toContain(
      'remotectl install: registered the task, but schtasks /Run failed: ERROR: busy',
    );

    schtasks.failures.delete = { code: 1, stdout: '', stderr: '' };
    expect(await run(['uninstall'])).toBe(EXIT_ERROR);
    expect(stderr).toContain('remotectl uninstall: schtasks /Delete failed: exit 1');
    expect(fs.files.has(xmlPath)).toBe(true);
  });

  it('treats a missing schtasks.exe as an unregistered task', async () => {
    schtasks.failures.query = Object.assign(new Error('spawn schtasks.exe ENOENT'), {
      code: 'ENOENT',
    });
    expect(await run(['status'])).toBe(EXIT_OK);
    expect(stdout).toContain('service:         not installed (`remotectl install`)\n');
  });

  it('refuses without a user name and from the npx cache', async () => {
    expect(await run(['install'], container({}, {}))).toBe(EXIT_ERROR);
    expect(stderr).toContain('remotectl install: cannot determine the Windows user (USERNAME).');

    const npx = `${LOCAL}\\npm-cache\\_npx\\0a1b2c\\node_modules\\remotectl\\dist\\cli.mjs`;
    fs.files.set(npx, new TextEncoder().encode('// bundle\n'));
    stderr = '';
    expect(await run(['install'], container({ scriptPath: npx }))).toBe(EXIT_ERROR);
    expect(stderr).toContain(`it is running from the npx cache (${npx})`);

    const temp = `${TEMP}\\remotectl\\dist\\cli.mjs`;
    fs.files.set(temp, new TextEncoder().encode('// bundle\n'));
    stderr = '';
    expect(await run(['install', '--dry-run'], container({ scriptPath: temp }))).toBe(EXIT_ERROR);
    expect(stderr).toContain('it is running from the temporary directory');
    expect(schtasks.calls).toEqual([]);
  });

  it('accepts a bare user name without a domain', async () => {
    expect(await run(['install', '--dry-run'], container({}, { USERNAME: 'tom' }))).toBe(EXIT_OK);
    expect(stdout).toContain('<UserId>tom</UserId>');
  });
});
