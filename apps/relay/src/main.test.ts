import { EventEmitter } from 'node:events';

import { createMemoryDestination } from '@remote-control/log';
import { describe, expect, it, vi } from 'vitest';

import { startServer } from './main.js';

describe('startServer', () => {
  it('listens, serves /health and drains to exit 0 on SIGTERM', async () => {
    const signals = new EventEmitter();
    const exit = vi.fn<(code: number) => void>();
    const destination = createMemoryDestination();
    const { app, shutdown } = await startServer({
      env: { RC_HOST: '127.0.0.1', RC_PORT: '0', RC_PUBLIC_DIR: '/nonexistent-rc-public' },
      signals,
      exit,
      destination,
    });

    const address = app.server.address();
    expect(typeof address === 'object' && address !== null && address.port > 0).toBe(true);
    const health = await app.inject('/health');
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok', db: 'disabled', commit: null });
    expect((await app.inject('/api/version')).json()).toMatchObject({ version: '0.0.0' });

    signals.emit('SIGTERM');
    await shutdown('SIGTERM');
    expect(exit).toHaveBeenCalledWith(0);
    expect(destination.lines().some((line) => line.includes('"event":"shutdown_complete"'))).toBe(
      true,
    );
  });

  it('rejects an invalid environment before listening', async () => {
    await expect(
      startServer({ env: { RC_PORT: 'nope' }, signals: new EventEmitter(), exit: vi.fn() }),
    ).rejects.toThrow(/RC_PORT/);
  });
});
