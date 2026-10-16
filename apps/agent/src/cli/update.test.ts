import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { createLogger } from '@remote-control/log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createContainer, type Container } from '../container.js';
import { UPDATE_CHECK_INTERVAL_MS } from '../core/update-check.js';
import type { Launchctl } from '../ports/launchctl.js';
import type { DistTagsResult, Registry } from '../ports/registry.js';
import type { Schtasks } from '../ports/schtasks.js';
import type { Systemctl } from '../ports/systemctl.js';
import type { Timer } from '../ports/timer.js';
import { AGENT_VERSION } from '../version.js';
import { EXIT_ERROR, EXIT_OK, runCli } from './main.js';
import { UPDATE_CACHE_FILE, checkForUpdate, startUpdateChecks } from './update.js';

// Any process start from this test (npm included) is recorded and refused (ADR 0002).
const spawned = vi.hoisted(() => [] as string[]);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const refuse =
    (name: string) =>
    (...args: unknown[]): never => {
      spawned.push(`${name} ${String(args[0])}`);
      throw new Error(`${name} is not allowed in this test`);
    };
  return {
    ...actual,
    spawn: refuse('spawn'),
    spawnSync: refuse('spawnSync'),
    exec: refuse('exec'),
    execSync: refuse('execSync'),
    execFile: refuse('execFile'),
    execFileSync: refuse('execFileSync'),
    fork: refuse('fork'),
  };
});

const NEWER = '99.0.0';

/** A registry that answers from a script and records every request. */
class FakeRegistry implements Registry {
  readonly requests: (string | undefined)[] = [];
  answers: DistTagsResult[] = [];

  distTags(etag?: string): Promise<DistTagsResult> {
    this.requests.push(etag);
    return Promise.resolve(this.answers.shift() ?? { status: 'failed' });
  }
}

/** Service managers that must never be asked anything here. */
function refusing<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get: (_, method) => () => Promise.reject(new Error(`${name}.${String(method)} called`)),
  });
}

/** A clock and a timer driven by hand: `advance` fires every due callback. */
function manualTime(start = 1_760_000_000_000) {
  let now = start;
  const timers: { at: number; callback: () => void; active: boolean }[] = [];
  const timer: Timer = {
    after(ms, callback) {
      const entry = { at: now + ms, callback, active: true };
      timers.push(entry);
      return { cancel: () => (entry.active = false) };
    },
  };
  return {
    clock: { now: () => now },
    timer,
    active: () => timers.filter((entry) => entry.active).length,
    advance(ms: number) {
      now += ms;
      for (const entry of timers) {
        if (entry.active && entry.at <= now) {
          entry.active = false;
          entry.callback();
        }
      }
    },
  };
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

describe('update check', () => {
  let base: string;
  let home: string;
  let registry: FakeRegistry;
  let time: ReturnType<typeof manualTime>;
  let stdout: string;
  let stderr: string;

  function container(env: Record<string, string> = {}): Container {
    return createContainer({
      platform: 'freebsd',
      env: { XDG_CACHE_HOME: join(home, '.cache'), ...env },
      homedir: home,
      tmpdir: join(base, 'tmp'),
      output: { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) },
      clock: time.clock,
      timer: time.timer,
      registry,
      launchctl: refusing<Launchctl>('launchctl'),
      systemctl: refusing<Systemctl>('systemctl'),
      schtasks: refusing<Schtasks>('schtasks'),
    });
  }

  const run = (argv: readonly string[], c = container()): Promise<number> =>
    runCli(argv, c, { signal: new AbortController().signal });

  const cacheFile = (): string => join(home, '.cache', 'remotectl', UPDATE_CACHE_FILE);

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'remotectl-update-')));
    home = join(base, 'home');
    await mkdir(home);
    registry = new FakeRegistry();
    time = manualTime();
    stdout = '';
    stderr = '';
    spawned.length = 0;
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('shows a newer version in status and update, spawning nothing and writing only the cache', async () => {
    registry.answers = [{ status: 'ok', latest: NEWER, etag: 'W/"1"' }];
    expect(await run(['status'])).toBe(EXIT_OK);
    expect(stdout).toContain(`update:          ${NEWER} available (run \`remotectl update\`)\n`);

    registry.answers = [{ status: 'ok', latest: NEWER, etag: 'W/"1"' }];
    stdout = '';
    expect(await run(['update'])).toBe(EXIT_OK);
    expect(stdout).toBe(
      `remotectl ${NEWER} is available (you have ${AGENT_VERSION}). To update:\n` +
        '  npm install -g remotectl@latest\n' +
        'then, if the agent runs as a service, point the service at the new version:\n' +
        '  remotectl uninstall && remotectl install\n',
    );
    expect(stderr).toBe('');

    // Only dist-tags requests (the second one conditional), no process, one file written.
    expect(registry.requests).toEqual([undefined, 'W/"1"']);
    expect(spawned).toEqual([]);
    expect(await listFiles(base)).toEqual([relative(base, cacheFile())]);
    expect(JSON.parse(await readFile(cacheFile(), 'utf8'))).toMatchObject({
      latest: NEWER,
      etag: 'W/"1"',
    });
    // Windows has no POSIX permission bits; the files are protected by the user profile ACL.
    if (process.platform !== 'win32') {
      expect((await stat(cacheFile())).mode & 0o777).toBe(0o600);
      expect((await stat(join(home, '.cache', 'remotectl'))).mode & 0o777).toBe(0o700);
    }
  });

  it('says the running version is the latest', async () => {
    registry.answers = [{ status: 'ok', latest: AGENT_VERSION }];
    expect(await run(['status'])).toBe(EXIT_OK);
    expect(stdout).toContain(`update:          ${AGENT_VERSION} is the latest\n`);
    registry.answers = [{ status: 'ok', latest: AGENT_VERSION }];
    stdout = '';
    expect(await run(['update'])).toBe(EXIT_OK);
    expect(stdout).toBe(`remotectl ${AGENT_VERSION} is up to date.\n`);
  });

  it('reuses a fresh answer for 24 h, then asks again with the ETag', async () => {
    registry.answers = [{ status: 'ok', latest: NEWER, etag: '"abc"' }];
    expect(await checkForUpdate(container(), { force: false })).toMatchObject({
      status: 'available',
      source: 'registry',
    });
    time.advance(UPDATE_CHECK_INTERVAL_MS - 1);
    expect(await checkForUpdate(container(), { force: false })).toMatchObject({
      status: 'available',
      latest: NEWER,
      source: 'cache',
    });
    expect(registry.requests).toEqual([undefined]);

    time.advance(1);
    registry.answers = [{ status: 'not-modified' }];
    expect(await checkForUpdate(container(), { force: false })).toMatchObject({
      status: 'available',
      latest: NEWER,
      source: 'registry',
    });
    expect(registry.requests).toEqual([undefined, '"abc"']);
    // The not-modified answer refreshed the cache and kept its ETag.
    expect(JSON.parse(await readFile(cacheFile(), 'utf8'))).toEqual({
      checkedAt: time.clock.now(),
      latest: NEWER,
      etag: '"abc"',
    });
    await checkForUpdate(container(), { force: false });
    expect(registry.requests).toHaveLength(2);
  });

  it('is unknown offline without a cache, and falls back to the cached answer', async () => {
    expect(await run(['status'])).toBe(EXIT_OK);
    expect(stdout).toContain('update:          unknown (offline)\n');
    expect(await run(['update'])).toBe(EXIT_ERROR);
    expect(stderr).toBe('remotectl update: could not reach the npm registry; try again later.\n');
    // A not-modified answer without a cache to refer to is no answer either.
    registry.answers = [{ status: 'not-modified' }];
    expect(await checkForUpdate(container(), { force: true })).toEqual({
      status: 'unknown',
      current: AGENT_VERSION,
    });

    registry.answers = [{ status: 'ok', latest: NEWER }];
    await checkForUpdate(container(), { force: false });
    time.advance(UPDATE_CHECK_INTERVAL_MS);
    stdout = '';
    stderr = '';
    expect(await run(['status'])).toBe(EXIT_OK);
    expect(stdout).toContain(`update:          ${NEWER} available`);
    expect(await run(['update'])).toBe(EXIT_ERROR);
    expect(stderr).toBe(
      'remotectl update: could not reach the npm registry; showing the last known answer.\n',
    );
    expect(stdout).toContain('npm install -g remotectl@latest');
  });

  it('treats a corrupt or unreadable cache as absent', async () => {
    await mkdir(join(home, '.cache', 'remotectl'), { recursive: true });
    await writeFile(cacheFile(), '{not json');
    registry.answers = [{ status: 'ok', latest: NEWER }];
    expect(await checkForUpdate(container(), { force: false })).toMatchObject({
      status: 'available',
    });
    expect(registry.requests).toEqual([undefined]);

    await rm(cacheFile());
    await mkdir(cacheFile());
    registry.answers = [{ status: 'ok', latest: AGENT_VERSION }];
    // Reading a directory fails and writing over it fails; both are ignored.
    expect(await checkForUpdate(container(), { force: false })).toMatchObject({
      status: 'current',
    });
  });

  it('honours REMOTECTL_NO_UPDATE_CHECK in status but not in update', async () => {
    const c = container({ REMOTECTL_NO_UPDATE_CHECK: '1' });
    expect(await run(['status'], c)).toBe(EXIT_OK);
    expect(stdout).toContain('update:          check disabled\n');
    expect(registry.requests).toEqual([]);
    registry.answers = [{ status: 'ok', latest: NEWER }];
    expect(await run(['update'], c)).toBe(EXIT_OK);
    expect(stdout).toContain(`remotectl ${NEWER} is available`);
    expect(registry.requests).toEqual([undefined]);
    // `update` asks even when the cache is fresh.
    registry.answers = [{ status: 'ok', latest: NEWER }];
    expect(await run(['update'], c)).toBe(EXIT_OK);
    expect(registry.requests).toHaveLength(2);
  });

  describe('startUpdateChecks', () => {
    function memoryLogger() {
      const lines: Record<string, unknown>[] = [];
      const logger = createLogger({
        timestamp: false,
        destination: {
          write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>),
        },
      });
      return { logger, lines };
    }

    it('logs update_available now and every 24 h, and stops cleanly', async () => {
      const { logger, lines } = memoryLogger();
      registry.answers = [{ status: 'ok', latest: NEWER }];
      const checks = startUpdateChecks(container(), logger);
      await vi.waitFor(() => expect(time.active()).toBe(1));
      expect(lines).toEqual([
        expect.objectContaining({
          level: 'warn',
          event: 'update_available',
          current: AGENT_VERSION,
          latest: NEWER,
        }),
      ]);
      expect(time.active()).toBe(1);

      // The next tick finds a fresh cache only if less than 24 h passed; here it asks again.
      registry.answers = [{ status: 'ok', latest: AGENT_VERSION }];
      time.advance(UPDATE_CHECK_INTERVAL_MS);
      expect(time.active()).toBe(0);
      await vi.waitFor(() => expect(time.active()).toBe(1));
      expect(registry.requests).toHaveLength(2);
      expect(lines).toHaveLength(1);
      expect(time.active()).toBe(1);

      await checks.stop();
      expect(time.active()).toBe(0);
    });

    it('keeps checking after a failed check and logs nothing after stop', async () => {
      const { logger, lines } = memoryLogger();
      const failing: Registry = { distTags: () => Promise.reject(new Error('boom')) };
      const c = { ...container(), registry: failing };
      const checks = startUpdateChecks(c, logger);
      await vi.waitFor(() => expect(time.active()).toBe(1));
      expect(lines).toEqual([]);

      // A check in flight when `stop` is called is awaited but neither logs nor re-arms.
      let answer: ((result: DistTagsResult) => void) | undefined;
      const slow: Registry = { distTags: () => new Promise((resolve) => (answer = resolve)) };
      const d = { ...container(), registry: slow };
      const second = startUpdateChecks(d, logger);
      await vi.waitFor(() => expect(answer).toBeDefined());
      const stopped = second.stop();
      answer?.({ status: 'ok', latest: NEWER });
      await stopped;
      expect(lines).toEqual([]);
      await checks.stop();
      expect(time.active()).toBe(0);
    });

    it('does nothing when checks are disabled', async () => {
      const { logger, lines } = memoryLogger();
      const checks = startUpdateChecks(container({ REMOTECTL_NO_UPDATE_CHECK: '1' }), logger);
      await checks.stop();
      expect(registry.requests).toEqual([]);
      expect(time.active()).toBe(0);
      expect(lines).toEqual([]);
    });
  });
});
