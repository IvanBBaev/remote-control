import pg from 'pg';
import type { Logger } from 'pino';

import type { Notification, NotifyBus } from '../ports/notify-bus.js';

const CONNECT_TIMEOUT_MS = 5_000;
/** Wait before re-opening a lost listening connection. */
const RECONNECT_DELAY_MS = 1_000;

/** Postgres identifiers quoted for `LISTEN` (channel names are ours, never user input). */
const quote = (channel: string) => `"${channel.replaceAll('"', '""')}"`;

/**
 * Production `NotifyBus` (ADR 0012): `LISTEN` on one dedicated `pg.Client` per replica
 * (03 F26), re-opened after a drop; `NOTIFY` on a second dedicated client, one
 * transaction per `publish`, serialised so notifications keep their order. Neither
 * takes a slot of the request pool.
 */
export function createPgNotifyBus(connectionString: string, logger: Logger): NotifyBus {
  let client: pg.Client | undefined;
  let publisher: pg.Client | undefined;
  let channels: readonly string[] = [];
  let handler: ((channel: string, payload: string) => void) | undefined;
  let closed = false;
  const reconnectListeners: (() => void)[] = [];
  let queue: Promise<void> = Promise.resolve();

  const open = async (): Promise<void> => {
    const next = new pg.Client({ connectionString, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
    next.on('notification', (message) => handler?.(message.channel, message.payload ?? ''));
    next.on('error', (error: Error & { code?: string }) => {
      logger.warn({ event: 'hub_listen_error', code: error.code ?? 'unknown' }, 'listen lost');
      if (client === next) {
        client = undefined;
        void next.end().catch(() => undefined);
        reopen();
      }
    });
    await next.connect();
    for (const channel of channels) await next.query(`LISTEN ${quote(channel)}`);
    client = next;
  };

  const reopen = (): void => {
    if (closed) return;
    setTimeout(() => {
      open().then(
        () => {
          logger.info({ event: 'hub_listen_restored' }, 'listen restored');
          for (const listener of reconnectListeners) listener();
        },
        () => reopen(),
      );
    }, RECONNECT_DELAY_MS).unref();
  };

  return {
    async listen(names, onMessage) {
      channels = names;
      handler = onMessage;
      await open();
    },
    publish(notifications: readonly Notification[]) {
      const run = queue.then(async () => {
        if (publisher === undefined) {
          const next = new pg.Client({
            connectionString,
            connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
          });
          // A drop surfaces as a rejected query below; without a listener it would crash.
          next.on('error', () => undefined);
          await next.connect();
          publisher = next;
        }
        const connection = publisher;
        try {
          await connection.query('BEGIN');
          for (const { channel, payload } of notifications) {
            await connection.query('SELECT pg_notify($1, $2)', [channel, payload]);
          }
          await connection.query('COMMIT');
        } catch (error) {
          publisher = undefined;
          await connection.end().catch(() => undefined);
          throw error;
        }
      });
      queue = run.catch(() => undefined);
      return run;
    },
    onReconnect(listener) {
      reconnectListeners.push(listener);
    },
    async close() {
      closed = true;
      await queue;
      const current = [client, publisher];
      client = undefined;
      publisher = undefined;
      await Promise.all(current.map((connection) => connection?.end() ?? Promise.resolve()));
    },
  };
}
