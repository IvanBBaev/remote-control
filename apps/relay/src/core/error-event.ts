import type { ErrorContext } from '../ports/error-reporter.js';
import { scrubMessage } from './scrub-message.js';

const MAX_FRAMES = 50;
const MAX_CAUSES = 3;

export interface ErrorEventMeta {
  /** 32 lower-case hex characters. */
  readonly eventId: string;
  readonly timestampMs: number;
  /** Build identifier (the git commit on Railway). */
  readonly release: string | undefined;
  readonly environment: string;
}

export interface StackFrame {
  readonly function?: string;
  readonly filename: string;
  readonly lineno: number;
  readonly colno: number;
  readonly in_app: boolean;
}

export interface ExceptionValue {
  readonly type: string;
  readonly value: string;
  readonly stacktrace?: { readonly frames: readonly StackFrame[] };
}

/**
 * The Sentry event the relay sends. It is built from an allow-list: exception types,
 * scrubbed messages, stack frames and the metadata tags of {@link ErrorContext}. There
 * is deliberately no `request`, `user`, `extra`, `contexts`, `breadcrumbs` or
 * `server_name` — the relay's metadata promise (D19, I1) covers its error reports too.
 */
export interface ErrorEvent {
  readonly event_id: string;
  readonly timestamp: number;
  readonly platform: 'node';
  readonly level: 'error' | 'fatal';
  readonly logger: 'relay';
  readonly release?: string;
  readonly environment: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly exception: { readonly values: readonly ExceptionValue[] };
}

const FATAL_EVENTS = new Set(['uncaught_exception', 'unhandled_rejection']);

function parseFrames(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const line of stack.split('\n')) {
    const match = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!match) continue;
    const [, fn, file = '', lineno = '0', colno = '0'] = match;
    const filename = file.replace(/^file:\/\//, '');
    frames.push({
      ...(fn === undefined ? {} : { function: fn }),
      filename,
      lineno: Number(lineno),
      colno: Number(colno),
      in_app: !filename.includes('/node_modules/') && !filename.startsWith('node:'),
    });
  }
  // V8 lists the newest frame first; Sentry wants the oldest first.
  return frames.slice(0, MAX_FRAMES).reverse();
}

function errorName(error: Error): string {
  // Error names are code identifiers (`TypeError`, `ConfigError`); anything else is suspect.
  return /^[A-Za-z_$][\w$]{0,63}$/.test(error.name) ? error.name : 'Error';
}

function toException(error: unknown): ExceptionValue {
  if (!(error instanceof Error)) {
    return { type: 'NonError', value: `thrown ${error === null ? 'null' : typeof error}` };
  }
  const frames = typeof error.stack === 'string' ? parseFrames(error.stack) : [];
  return {
    type: errorName(error),
    value: scrubMessage(error.message),
    ...(frames.length > 0 ? { stacktrace: { frames } } : {}),
  };
}

/** Builds the payload-free Sentry event for `error` (see {@link ErrorEvent}). */
export function buildErrorEvent(
  error: unknown,
  context: ErrorContext,
  meta: ErrorEventMeta,
): ErrorEvent {
  // The cause chain, outermost last (Sentry shows the last value as the headline).
  const chain: unknown[] = [error];
  let current: unknown = error;
  while (chain.length <= MAX_CAUSES && current instanceof Error && current.cause !== undefined) {
    current = current.cause;
    chain.unshift(current);
  }
  // Tag values come from request metadata (the request id is a header): keep only
  // short identifier-like values.
  const tags: Record<string, string> = {};
  const candidates = [
    ['event', context.event],
    ['req_id', context.reqId],
    ['method', context.method],
    ['route', context.route],
  ] as const;
  for (const [key, value] of candidates) {
    if (value !== undefined && /^[\w./:*-]{1,100}$/.test(value)) tags[key] = value;
  }
  return {
    event_id: meta.eventId,
    timestamp: meta.timestampMs / 1000,
    platform: 'node',
    level: FATAL_EVENTS.has(context.event) ? 'fatal' : 'error',
    logger: 'relay',
    ...(meta.release === undefined ? {} : { release: meta.release }),
    environment: meta.environment,
    tags,
    exception: { values: chain.map(toException) },
  };
}
