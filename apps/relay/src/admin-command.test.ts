import type { Random } from '@remote-control/protocol';
import { describe, expect, it, vi } from 'vitest';

import { ADMIN_USAGE, runAdminCommand, type AdminCommandOptions } from './admin-command.js';
import type { AccountStore } from './ports/account-store.js';

const DATABASE_URL = 'postgres://rc:pw@127.0.0.1:1/rc';
const NOW = Date.UTC(2026, 9, 1);
const zeros: Random = { bytes: (n) => new Uint8Array(n) };

function run(argv: string[], overrides: Partial<AdminCommandOptions> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const createInvites = vi.fn<AccountStore['createInvites']>(() => Promise.resolve());
  const close = vi.fn(() => Promise.resolve());
  const openStore = vi.fn(() => ({ store: { createInvites } as unknown as AccountStore, close }));
  const result = runAdminCommand({
    argv,
    env: { RC_DATABASE_URL: DATABASE_URL },
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    openStore,
    clock: { now: () => NOW },
    random: zeros,
    ...overrides,
  });
  return { result, stdout, stderr, createInvites, close, openStore };
}

describe('runAdminCommand', () => {
  it('mints invite codes, prints them to stdout only and stores their hashes', async () => {
    const { result, stdout, stderr, createInvites, close, openStore } = run([
      'invite',
      '--count',
      '3',
      '--ttl-days',
      '2',
    ]);
    expect(await result).toBe(0);
    expect(openStore).toHaveBeenCalledWith(DATABASE_URL);
    expect(stdout).toHaveLength(3);
    for (const code of stdout) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(stderr).toEqual(['3 invite code(s), single use, valid until 2026-10-03T00:00:00.000Z']);
    const [hashes, expiresAt] = createInvites.mock.calls[0]!;
    expect(hashes).toHaveLength(3);
    expect(expiresAt).toBe(NOW + 2 * 24 * 60 * 60 * 1000);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('defaults to one code valid for 7 days', async () => {
    const { result, stdout, createInvites } = run(['invite']);
    expect(await result).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(createInvites.mock.calls[0]![1]).toBe(NOW + 7 * 24 * 60 * 60 * 1000);
  });

  it.each([
    [[]],
    [['revoke']],
    [['invite', 'extra']],
    [['invite', '--count', '0']],
    [['invite', '--count', '101']],
    [['invite', '--count', 'many']],
    [['invite', '--ttl-days', '91']],
    [['invite', '--unknown']],
  ])('prints usage and exits 2 for %j', async (argv) => {
    const { result, stderr, openStore } = run(argv);
    expect(await result).toBe(2);
    expect(stderr).toEqual([ADMIN_USAGE]);
    expect(openStore).not.toHaveBeenCalled();
  });

  it('prints a fresh VAPID key pair without opening the database (M0-12)', async () => {
    const { result, stdout, stderr, openStore } = run(['vapid-keys'], { env: {} });
    expect(await result).toBe(0);
    expect(stdout).toHaveLength(2);
    expect(stdout[0]).toMatch(/^RC_VAPID_PUBLIC=B[A-Za-z0-9_-]{86}$/);
    expect(stdout[1]).toMatch(/^RC_VAPID_PRIVATE=[A-Za-z0-9_-]{43}$/);
    expect(stderr).toEqual([]);
    expect(openStore).not.toHaveBeenCalled();
    expect(ADMIN_USAGE).toContain('vapid-keys');
    const extra = run(['vapid-keys', 'now']);
    expect(await extra.result).toBe(2);
  });

  it('exits 1 without a database URL or with an invalid configuration', async () => {
    const missing = run(['invite'], { env: {} });
    expect(await missing.result).toBe(1);
    expect(missing.stderr[0]).toMatch(/RC_DATABASE_URL/);
    const invalid = run(['invite'], { env: { RC_DATABASE_URL: DATABASE_URL, RC_PORT: 'x' } });
    expect(await invalid.result).toBe(1);
    expect(invalid.stderr[0]).toMatch(/RC_PORT/);
    expect(invalid.openStore).not.toHaveBeenCalled();
  });

  it('exits 1 with a generic message when the store fails, and still closes it', async () => {
    const { result, stdout, stderr, createInvites, close } = run(['invite']);
    createInvites.mockRejectedValueOnce(new Error(`connect ECONNREFUSED ${DATABASE_URL}`));
    expect(await result).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join('\n')).not.toContain('pw@');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('opens the configured Postgres database by default', async () => {
    const { result, stderr } = run(['invite'], {
      openStore: undefined,
      clock: undefined,
      random: undefined,
    });
    // Nothing listens on port 1: the default pg store is wired and fails cleanly.
    expect(await result).toBe(1);
    expect(stderr).toEqual([
      'minting invite codes failed (is the database migrated and reachable?)',
    ]);
  });
});
