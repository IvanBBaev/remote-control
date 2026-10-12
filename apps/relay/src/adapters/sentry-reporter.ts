import { toHex, type Clock, type Random } from '@remote-control/protocol';
import type { Logger } from 'pino';

import { buildErrorEvent } from '../core/error-event.js';
import type { SentryDsn } from '../core/sentry-dsn.js';
import type { ErrorContext, ErrorReporter } from '../ports/error-reporter.js';

export interface SentryReporterOptions {
  readonly dsn: SentryDsn;
  readonly release: string | undefined;
  readonly environment: string;
  readonly clock: Clock;
  readonly random: Random;
  readonly logger: Logger;
  /** Default: global `fetch`. Tests pass a recorder. */
  readonly fetch?: typeof fetch;
  /** Abort one send after this long; default 5 s. */
  readonly timeoutMs?: number;
  /** At most this many reports per minute (free tier: 5k/month); default 20. */
  readonly perMinute?: number;
}

const MINUTE_MS = 60_000;

/**
 * The {@link ErrorReporter} over Sentry's envelope endpoint, without the Sentry SDK: the
 * SDK instruments `http`, records breadcrumbs and attaches request data, all of which
 * would have to be scrubbed again. Here the event is built from an allow-list
 * ({@link buildErrorEvent}) and sent with one `fetch`; failures are logged and dropped.
 */
export function createSentryReporter(options: SentryReporterOptions): ErrorReporter {
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const perMinute = options.perMinute ?? 20;
  const pending = new Set<Promise<void>>();
  let windowStart = Number.NEGATIVE_INFINITY;
  let windowCount = 0;
  let dropped = 0;

  const post = async (body: string): Promise<void> => {
    try {
      const response = await send(options.dsn.envelopeUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-sentry-envelope',
          'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${options.dsn.publicKey}, sentry_client=remote-control-relay/1`,
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        options.logger.warn(
          { event: 'sentry_send_failed', status: response.status },
          'error report rejected',
        );
      }
    } catch {
      options.logger.warn({ event: 'sentry_send_failed', status: null }, 'error report not sent');
    }
  };

  return {
    capture(error: unknown, context: ErrorContext): void {
      const now = options.clock.now();
      if (now - windowStart >= MINUTE_MS) {
        if (dropped > 0) {
          options.logger.warn({ event: 'sentry_rate_limited', dropped }, 'error reports dropped');
        }
        windowStart = now;
        windowCount = 0;
        dropped = 0;
      }
      if (windowCount >= perMinute) {
        dropped += 1;
        return;
      }
      windowCount += 1;
      const event = buildErrorEvent(error, context, {
        eventId: toHex(options.random.bytes(16)),
        timestampMs: now,
        release: options.release,
        environment: options.environment,
      });
      const header = {
        event_id: event.event_id,
        sent_at: new Date(now).toISOString(),
        dsn: options.dsn.dsn,
      };
      const body = `${JSON.stringify(header)}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`;
      const sending = post(body).finally(() => pending.delete(sending));
      pending.add(sending);
    },

    async flush(flushTimeoutMs: number): Promise<boolean> {
      if (pending.size === 0) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), flushTimeoutMs);
        timer.unref();
      });
      const done = Promise.allSettled([...pending]).then(() => true as const);
      try {
        return await Promise.race([done, timedOut]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
