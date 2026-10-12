import { pino, type DestinationStream, type Level, type Logger } from 'pino';

import { REDACT_CENSOR, REDACT_PATHS } from './redact.js';

export interface CreateLoggerOptions {
  /** Minimum level; default `info`. Payload-bearing debug output stays off by default. */
  readonly level?: Level | 'silent';
  /** Service name, written as `name` on every line (e.g. `relay`, `agent`). */
  readonly name?: string;
  /**
   * Where lines go; default stdout. Pass an in-memory destination in tests or the
   * result of `createRollingDestination` in the agent.
   */
  readonly destination?: DestinationStream;
  /** Write an ISO `time` field; default `true`. Tests turn it off for stable lines. */
  readonly timestamp?: boolean;
}

/**
 * Creates the shared pino logger: `level` rendered as a label so Railway classifies
 * severity, no `pid`/`hostname` base fields, and the D19 redaction list applied.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  return pino(
    {
      level: options.level ?? 'info',
      base: options.name === undefined ? null : { name: options.name },
      formatters: { level: (label) => ({ level: label }) },
      timestamp: options.timestamp === false ? false : pino.stdTimeFunctions.isoTime,
      redact: { paths: [...REDACT_PATHS], censor: REDACT_CENSOR },
    },
    options.destination ?? pino.destination(1),
  );
}
