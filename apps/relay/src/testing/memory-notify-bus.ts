import type { Notification, NotifyBus } from '../ports/notify-bus.js';

type Handler = (channel: string, payload: string) => void;

/**
 * An in-memory Postgres `NOTIFY` for core tests: every bus made by {@link bus} is one
 * replica's connection. Delivery is asynchronous (a microtask), in publish order, and
 * includes the publisher's own listeners, as on Postgres.
 */
export class MemoryNotifyNetwork {
  readonly #listeners = new Set<{ channels: Set<string>; handler: Handler }>();
  readonly #reconnects = new Set<() => void>();
  /** Every payload published so far. */
  readonly published: Notification[] = [];
  readonly #partitioned = new Set<NotifyBus>();

  bus(): NotifyBus {
    const own: { channels: Set<string>; handler: Handler }[] = [];
    const reconnects: (() => void)[] = [];
    const bus: NotifyBus = {
      listen: (channels, handler) => {
        const entry = { channels: new Set(channels), handler };
        own.push(entry);
        this.#listeners.add(entry);
        return Promise.resolve();
      },
      publish: (notifications) => {
        if (this.#partitioned.has(bus)) return Promise.reject(new Error('partitioned'));
        this.published.push(...notifications);
        const targets = [...this.#listeners];
        queueMicrotask(() => {
          for (const { channel, payload } of notifications) {
            for (const target of targets) {
              if (this.#listeners.has(target) && target.channels.has(channel)) {
                target.handler(channel, payload);
              }
            }
          }
        });
        return Promise.resolve();
      },
      onReconnect: (listener) => {
        reconnects.push(listener);
        this.#reconnects.add(listener);
      },
      close: () => {
        for (const entry of own) this.#listeners.delete(entry);
        for (const listener of reconnects) this.#reconnects.delete(listener);
        return Promise.resolve();
      },
    };
    return bus;
  }

  /** Makes `bus` fail every publish (`true`) or work again (`false`). */
  partition(bus: NotifyBus, failing: boolean): void {
    if (failing) this.#partitioned.add(bus);
    else this.#partitioned.delete(bus);
  }

  /** Runs every bus's reconnect listeners, as after a dropped `LISTEN` connection. */
  reconnectAll(): void {
    for (const listener of this.#reconnects) listener();
  }
}

/** Lets queued notifications (microtasks) be delivered. */
export const flushNotifications = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};
