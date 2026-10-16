import { createLogger, createMemoryDestination } from '@remote-control/log';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPgNotifyBus } from './pg-notify-bus.js';

// A stand-in for `pg.Client`: each test scripts what `connect` and `query` do. The real
// connection paths run against Postgres in `pg-notify-bus.pg-real.test.ts`.
const fake = vi.hoisted(() => {
  const state = {
    clients: [] as InstanceType<typeof FakeClientBase>[],
    connect: (): Promise<void> => Promise.resolve(),
    query: (_text: string): Promise<void> => Promise.resolve(),
  };
  class FakeClientBase {
    readonly queries: string[] = [];
    readonly end = vi.fn(() => Promise.resolve());
    readonly handlers = new Map<string, (...args: unknown[]) => void>();
    constructor() {
      state.clients.push(this);
    }
    on(event: string, handler: (...args: unknown[]) => void): this {
      this.handlers.set(event, handler);
      return this;
    }
    connect(): Promise<void> {
      return state.connect();
    }
    query(text: string): Promise<void> {
      this.queries.push(text);
      return state.query(text);
    }
  }
  return { state, FakeClientBase };
});

vi.mock('pg', () => ({ default: { Client: fake.FakeClientBase } }));

const logger = createLogger({ level: 'info', destination: createMemoryDestination() });
const CONNECTION = 'postgres://localhost/relay';

describe('createPgNotifyBus', () => {
  beforeEach(() => {
    fake.state.clients = [];
    fake.state.connect = () => Promise.resolve();
    fake.state.query = () => Promise.resolve();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ends the listening client when a LISTEN fails', async () => {
    fake.state.query = (text) =>
      text.startsWith('LISTEN') ? Promise.reject(new Error('denied')) : Promise.resolve();
    const bus = createPgNotifyBus(CONNECTION, logger);
    await expect(bus.listen(['rc_hub'], () => undefined)).rejects.toThrow('denied');
    expect(fake.state.clients[0]?.end).toHaveBeenCalledOnce();
  });

  it('ends a listening client that connected after close', async () => {
    let connected: () => void = () => undefined;
    fake.state.connect = () => new Promise<void>((resolve) => (connected = resolve));
    const bus = createPgNotifyBus(CONNECTION, logger);
    const listening = bus.listen(['rc_hub'], () => undefined);
    await bus.close();
    connected();
    await expect(listening).rejects.toThrow('notify bus closed');
    expect(fake.state.clients[0]?.end).toHaveBeenCalledOnce();
  });

  it('flushes earlier publishes on close and refuses later ones', async () => {
    const bus = createPgNotifyBus(CONNECTION, logger);
    const sent = bus.publish([{ channel: 'rc_hub', payload: 'x' }]);
    await bus.close();
    await expect(sent).resolves.toBeUndefined();
    expect(fake.state.clients[0]?.queries).toEqual(['BEGIN', 'SELECT pg_notify($1, $2)', 'COMMIT']);
    expect(fake.state.clients[0]?.end).toHaveBeenCalledOnce();

    await expect(bus.publish([{ channel: 'rc_hub', payload: 'y' }])).rejects.toThrow(
      'notify bus closed',
    );
    expect(fake.state.clients).toHaveLength(1);
  });

  it('replaces the publisher after a failed publish', async () => {
    const bus = createPgNotifyBus(CONNECTION, logger);
    fake.state.query = (text) =>
      text === 'COMMIT' ? Promise.reject(new Error('lost')) : Promise.resolve();
    await expect(bus.publish([{ channel: 'rc_hub', payload: 'x' }])).rejects.toThrow('lost');
    expect(fake.state.clients[0]?.end).toHaveBeenCalledOnce();
    fake.state.query = () => Promise.resolve();
    await bus.publish([{ channel: 'rc_hub', payload: 'y' }]);
    expect(fake.state.clients).toHaveLength(2);
    await bus.close();
  });

  it('re-listens after a drop, and not once closed', async () => {
    vi.useFakeTimers();
    const bus = createPgNotifyBus(CONNECTION, logger);
    const reconnected = vi.fn();
    bus.onReconnect(reconnected);
    await bus.listen(['rc_hub'], () => undefined);

    fake.state.clients[0]?.handlers.get('error')?.(new Error('dropped'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.state.clients).toHaveLength(2);
    expect(fake.state.clients[1]?.queries).toEqual(['LISTEN "rc_hub"']);
    expect(reconnected).toHaveBeenCalledOnce();

    fake.state.clients[1]?.handlers.get('error')?.(new Error('dropped'));
    await bus.close();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.state.clients).toHaveLength(2);
  });
});
