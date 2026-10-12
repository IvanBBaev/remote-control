import { createMemoryDestination } from '@remote-control/log';
import { describe, expect, it, vi } from 'vitest';

import { runMigrateCommand } from './migrate-command.js';

describe('runMigrateCommand', () => {
  it('migrates the configured database and exits 0', async () => {
    const destination = createMemoryDestination();
    const migrate = vi.fn(() => Promise.resolve({ applied: 1, total: 1 }));
    const code = await runMigrateCommand({
      env: { RC_DATABASE_URL: 'postgres://rc:secret@db/rc' },
      destination,
      migrate,
    });
    expect(code).toBe(0);
    expect(migrate).toHaveBeenCalledWith('postgres://rc:secret@db/rc');
    const logged = destination.lines().join('\n');
    expect(logged).toContain('"event":"migrations_applied"');
    expect(logged).not.toContain('secret');
  });

  it('exits 1 without a database URL', async () => {
    const destination = createMemoryDestination();
    const migrate = vi.fn(() => Promise.resolve({ applied: 0, total: 0 }));
    expect(await runMigrateCommand({ env: {}, destination, migrate })).toBe(1);
    expect(migrate).not.toHaveBeenCalled();
    expect(destination.lines().join('\n')).toContain('"event":"migrations_failed"');
  });

  it('exits 1 on an invalid environment or a failed migration', async () => {
    const destination = createMemoryDestination();
    expect(await runMigrateCommand({ env: { RC_PORT: 'nope' }, destination })).toBe(1);
    const migrate = vi.fn(() => Promise.reject(new Error('lock timeout')));
    expect(
      await runMigrateCommand({ env: { DATABASE_URL: 'postgres://db/rc' }, destination, migrate }),
    ).toBe(1);
  });

  it('uses the real pg migrator by default', async () => {
    const destination = createMemoryDestination();
    // Port 1 refuses the connection, so the default runner fails fast.
    expect(
      await runMigrateCommand({
        env: { RC_DATABASE_URL: 'postgres://rc@127.0.0.1:1/rc' },
        destination,
      }),
    ).toBe(1);
  });
});
