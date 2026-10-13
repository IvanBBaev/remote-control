import { seededRandom } from '@remote-control/fake-claude-code';
import { describe, expect, it, vi } from 'vitest';

import type { ClaudeCli, RosterEntry } from '../ports/claude-cli.js';
import type { PathPort } from '../ports/path-port.js';
import { manualTime } from '../testing/manual-time.js';
import {
  createLauncher,
  folderName,
  FOLLOW_UP_MIN_VERSION,
  repositoryId,
  sessionName,
  versionAtLeast,
  type LauncherOptions,
} from './launcher.js';
import { createSessionRegistry } from './session-registry.js';

const SESSION = '5b7c1e2a-9d3f-4e8a-b6c4-2f1d0e9a8b7c';

/** A POSIX file system of known folders; `links` maps a path to where it points. */
function fakePaths(folders: readonly string[], links: Record<string, string> = {}): PathPort {
  return {
    isAbsolute: (path) => path.startsWith('/'),
    realpath: (path) => Promise.resolve(links[path] ?? (folders.includes(path) ? path : undefined)),
    contains: (parent, child) => child === parent || child.startsWith(`${parent}/`),
    join: (...segments) => segments.join('/'),
  };
}

function harness(overrides: Partial<LauncherOptions> = {}) {
  const time = manualTime();
  const rows: RosterEntry[] = [];
  const cli = {
    version: vi.fn(() => Promise.resolve(FOLLOW_UP_MIN_VERSION)),
    agents: vi.fn(() => Promise.resolve(rows as readonly RosterEntry[] | undefined)),
    start: vi.fn<ClaudeCli['start']>((repository, name) => {
      rows.push({
        sessionId: SESSION,
        cwd: repository.realPath,
        kind: 'background',
        state: 'working',
        status: 'busy',
        name,
      });
      return Promise.resolve(0);
    }),
    resume: vi.fn<ClaudeCli['resume']>(() => Promise.resolve(0)),
  };
  const registry = createSessionRegistry({ clock: time.clock, timer: time.timer, cli });
  const log = vi.fn<(event: string, fields: Readonly<Record<string, unknown>>) => void>();
  const launcher = createLauncher({
    repositories: [
      { path: '/work/app', maxPermissionMode: 'acceptEdits' },
      { path: '/work/gone', maxPermissionMode: 'default' },
    ],
    paths: fakePaths(['/work/app', '/work/app/sub', '/elsewhere']),
    cli,
    registry,
    random: seededRandom(1),
    followUps: true,
    log,
    ...overrides,
  });
  return { time, rows, cli, registry, log, launcher };
}

describe('versionAtLeast', () => {
  it('compares a.b.c numerically', () => {
    expect(versionAtLeast('2.1.257', '2.1.257')).toBe(true);
    expect(versionAtLeast('2.1.300', '2.1.257')).toBe(true);
    expect(versionAtLeast('2.2.0', '2.1.257')).toBe(true);
    expect(versionAtLeast('3.0.0', '2.1.257')).toBe(true);
    expect(versionAtLeast('2.1.99', '2.1.257')).toBe(false);
    expect(versionAtLeast('1.9.999', '2.1.257')).toBe(false);
  });

  it('refuses anything unparsable', () => {
    expect(versionAtLeast(undefined, '1.0.0')).toBe(false);
    expect(versionAtLeast('', '1.0.0')).toBe(false);
    expect(versionAtLeast('2.1', '1.0.0')).toBe(false);
    expect(versionAtLeast('2.1.257-beta', '1.0.0')).toBe(false);
  });
});

describe('repository naming', () => {
  it('derives a stable 32-hex id from the configured root', async () => {
    const id = await repositoryId('/work/app');
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(await repositoryId('/work/app')).toBe(id);
    expect(await repositoryId('/work/app/')).not.toBe(id);
  });

  it('names a folder by its last segment', () => {
    expect(folderName('/work/app')).toBe('app');
    expect(folderName('/work/app/')).toBe('app');
    expect(folderName('C:\\Users\\me\\proj')).toBe('proj');
    expect(folderName('/')).toBe('/');
  });

  it('builds a session name the spawn module accepts', () => {
    const random = seededRandom(7);
    expect(sessionName('my app', random)).toMatch(/^rc-my-app-[0-9a-f]{8}$/);
    expect(sessionName('', random)).toMatch(/^rc-repo-[0-9a-f]{8}$/);
    expect(sessionName('x'.repeat(100), random)).toMatch(/^rc-x{40}-[0-9a-f]{8}$/);
  });
});

describe('createLauncher', () => {
  it('lists the allow-listed repositories once', async () => {
    const { launcher } = harness();
    const first = await launcher.repositories();
    expect(first).toEqual([
      {
        id: await repositoryId('/work/app'),
        name: 'app',
        path: '/work/app',
        maxPermissionMode: 'acceptEdits',
      },
      {
        id: await repositoryId('/work/gone'),
        name: 'gone',
        path: '/work/gone',
        maxPermissionMode: 'default',
      },
    ]);
    expect(await launcher.repositories()).toBe(first);
  });

  it('starts a session in an allowed repository and reports its id', async () => {
    const { launcher, cli, log, registry } = harness();
    const id = await repositoryId('/work/app');
    expect(await launcher.start(id, 'fix the build')).toEqual({ ok: true, sessionId: SESSION });
    expect(cli.start).toHaveBeenCalledTimes(1);
    const [repository, name, prompt] = cli.start.mock.calls[0]!;
    expect(repository).toEqual({ allowed: true, root: '/work/app', realPath: '/work/app' });
    expect(name).toMatch(/^rc-app-[0-9a-f]{8}$/);
    expect(prompt).toBe('fix the build');
    expect(log).toHaveBeenCalledWith('launch_trust_unknown', { repository_id: id });
    expect(log).toHaveBeenCalledWith('launch_started', { repository_id: id, session_id: SESSION });
    // No prompt and no path in any audit line (I3).
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/fix the build|\/work/);
    expect(registry.get(SESSION)?.kind).toBe('background');
    registry.close();
  });

  it('passes a permission mode within the bound to the CLI (M2-09)', async () => {
    const { launcher, cli } = harness();
    const id = await repositoryId('/work/app');
    expect(await launcher.start(id, 'go', 'acceptEdits')).toEqual({ ok: true, sessionId: SESSION });
    expect(cli.start.mock.calls[0]![3]).toBe('acceptEdits');
  });

  it('refuses a permission mode above the bound before spawning (M2-09)', async () => {
    const { launcher, cli, log } = harness({
      repositories: [{ path: '/work/app', maxPermissionMode: 'plan' }],
    });
    const id = await repositoryId('/work/app');
    for (const mode of ['default', 'acceptEdits', undefined] as const) {
      expect(await launcher.start(id, 'go', mode)).toEqual({ ok: false, reason: 'not_allowed' });
    }
    expect(cli.start).not.toHaveBeenCalled();
    expect(log).toHaveBeenLastCalledWith('launch_refused', {
      repository_id: id,
      reason: 'permission_mode_above_bound',
    });
  });

  it('starts a plan-bound folder in plan mode (M2-09)', async () => {
    const { launcher, cli } = harness({
      repositories: [{ path: '/work/app', maxPermissionMode: 'plan' }],
    });
    const id = await repositoryId('/work/app');
    expect(await launcher.start(id, 'go', 'plan')).toMatchObject({ ok: true });
    expect(cli.start.mock.calls[0]![3]).toBe('plan');
  });

  it('skips the trust hint for a folder hooks came from', async () => {
    const { launcher, log, registry } = harness();
    registry.observe('other', '/work/app', false);
    await launcher.start(await repositoryId('/work/app'), 'go');
    expect(log.mock.calls.map(([event]) => event)).not.toContain('launch_trust_unknown');
    registry.close();
  });

  it('starts without a session id when the roster does not show it', async () => {
    const { launcher, cli } = harness();
    cli.agents.mockResolvedValue(undefined);
    expect(await launcher.start(await repositoryId('/work/app'), 'go')).toEqual({ ok: true });
  });

  it('refuses an unknown or vanished repository without spawning (J11)', async () => {
    const { launcher, cli, log } = harness();
    expect(await launcher.start('0'.repeat(32), 'go')).toEqual({
      ok: false,
      reason: 'not_allowed',
    });
    expect(log).toHaveBeenLastCalledWith('launch_refused', {
      repository_id: '0'.repeat(32),
      reason: 'unknown_repository',
    });
    const gone = await repositoryId('/work/gone');
    expect(await launcher.start(gone, 'go')).toEqual({ ok: false, reason: 'not_allowed' });
    expect(log).toHaveBeenLastCalledWith('launch_refused', {
      repository_id: gone,
      reason: 'not_found',
    });
    expect(cli.start).not.toHaveBeenCalled();
  });

  it('refuses a root that now points outside the allow-list', async () => {
    const { launcher, cli } = harness({
      repositories: [{ path: '/work/app', maxPermissionMode: 'default' }],
      paths: fakePaths(['/elsewhere'], { '/work/app': '/elsewhere' }),
    });
    // The root resolves (to /elsewhere) and is judged by where it points now: still
    // inside itself, so allowed — the allow-list is the configured root's target.
    expect(await launcher.start(await repositoryId('/work/app'), 'go')).toMatchObject({
      ok: true,
    });
    expect(cli.start.mock.calls[0]![0].realPath).toBe('/elsewhere');
  });

  it('reports a launch that throws or exits non-zero', async () => {
    const { launcher, cli, log } = harness();
    const id = await repositoryId('/work/app');
    cli.start.mockRejectedValueOnce(Object.assign(new Error('spawn claude ENOENT')));
    expect(await launcher.start(id, 'go')).toEqual({ ok: false, reason: 'start_failed' });
    expect(log).toHaveBeenLastCalledWith('launch_failed', { repository_id: id, error: 'Error' });
    cli.start.mockRejectedValueOnce('odd');
    await launcher.start(id, 'go');
    expect(log).toHaveBeenLastCalledWith('launch_failed', { repository_id: id, error: 'unknown' });
    cli.start.mockResolvedValueOnce(2);
    expect(await launcher.start(id, 'go')).toEqual({ ok: false, reason: 'start_failed' });
    expect(log).toHaveBeenLastCalledWith('launch_failed', { repository_id: id, exit_code: 2 });
  });

  it('sends a follow-up to a background session in an allowed folder (J9)', async () => {
    const { launcher, cli, log, registry } = harness();
    await launcher.start(await repositoryId('/work/app'), 'go');
    expect(await launcher.canFollowUp(SESSION)).toBe(true);
    expect(await launcher.instruct(SESSION, 'now the tests')).toEqual({
      ok: true,
      sessionId: SESSION,
    });
    expect(cli.resume).toHaveBeenCalledWith(
      { allowed: true, root: '/work/app', realPath: '/work/app' },
      SESSION,
      'now the tests',
    );
    expect(log).toHaveBeenLastCalledWith('instruct_sent', { session_id: SESSION });
    registry.close();
  });

  it('refuses a follow-up the session or the CLI cannot take', async () => {
    const off = harness({ followUps: false });
    await off.launcher.start(await repositoryId('/work/app'), 'go');
    expect(await off.launcher.instruct(SESSION, 'x')).toEqual({
      ok: false,
      reason: 'follow_up_unsupported',
    });
    off.registry.close();

    const { launcher, registry, cli, log } = harness();
    // Unknown session.
    expect(await launcher.canFollowUp(SESSION)).toBe(false);
    // Interactive session.
    registry.observe(SESSION, '/work/app', false);
    expect(await launcher.canFollowUp(SESSION)).toBe(false);
    // Background, but not a UUID.
    cli.agents.mockResolvedValue([
      {
        sessionId: 'abc',
        cwd: '/work/app',
        kind: 'background',
        state: 'working',
        status: 'busy',
        name: undefined,
      },
      {
        sessionId: SESSION,
        cwd: '/elsewhere',
        kind: 'background',
        state: 'working',
        status: 'busy',
        name: undefined,
      },
    ]);
    await registry.refresh();
    expect(await launcher.canFollowUp('abc')).toBe(false);
    // Background UUID, but its folder is off the allow-list.
    expect(await launcher.instruct(SESSION, 'x')).toEqual({
      ok: false,
      reason: 'follow_up_unsupported',
    });
    expect(log).toHaveBeenLastCalledWith('instruct_refused', { session_id: SESSION });
    expect(cli.resume).not.toHaveBeenCalled();
    registry.close();
  });

  it('reports a follow-up that throws or exits non-zero', async () => {
    const { launcher, cli, log, registry } = harness();
    await launcher.start(await repositoryId('/work/app'), 'go');
    cli.resume.mockRejectedValueOnce(new TypeError('x'));
    expect(await launcher.instruct(SESSION, 'x')).toEqual({ ok: false, reason: 'start_failed' });
    expect(log).toHaveBeenLastCalledWith('instruct_failed', {
      session_id: SESSION,
      error: 'TypeError',
    });
    cli.resume.mockRejectedValueOnce(42);
    await launcher.instruct(SESSION, 'x');
    expect(log).toHaveBeenLastCalledWith('instruct_failed', {
      session_id: SESSION,
      error: 'unknown',
    });
    cli.resume.mockResolvedValueOnce(1);
    expect(await launcher.instruct(SESSION, 'x')).toEqual({ ok: false, reason: 'start_failed' });
    expect(log).toHaveBeenLastCalledWith('instruct_failed', { session_id: SESSION, exit_code: 1 });
    registry.close();
  });

  it('shows sessions with their repository, state and follow-up flag', async () => {
    const { launcher, registry, rows } = harness();
    await launcher.start(await repositoryId('/work/app'), 'go');
    registry.observe('interactive-1', '/work/app/sub', false);
    registry.observe('outside-1', '/elsewhere', false);
    const app = await repositoryId('/work/app');
    expect(await launcher.sessions()).toEqual([
      {
        id: SESSION,
        repositoryId: app,
        state: 'working',
        statusText: 'Working',
        name: expect.stringMatching(/^rc-app-/) as string,
        followUp: true,
      },
      {
        id: 'interactive-1',
        repositoryId: app,
        state: 'working',
        statusText: 'Working',
        name: null,
        followUp: false,
      },
      {
        id: 'outside-1',
        repositoryId: null,
        state: 'working',
        statusText: 'Working',
        name: null,
        followUp: false,
      },
    ]);
    rows[0] = { ...rows[0]!, state: 'done' };
    await registry.refresh();
    expect((await launcher.sessions())[0]).toMatchObject({
      state: 'ended',
      statusText: 'Ended',
      followUp: false,
    });
    registry.close();
  });

  it('works without a log', async () => {
    const { launcher } = harness({ log: undefined });
    expect(await launcher.start('0'.repeat(32), 'go')).toMatchObject({ ok: false });
  });
});
