/** Database state as seen by `/health`: `disabled` only in development without a database. */
export type DatabaseStatus = 'ok' | 'error' | 'disabled';

export interface HealthInput {
  readonly draining: boolean;
  /** `undefined` while draining: the database is not probed during shutdown. */
  readonly db: DatabaseStatus | undefined;
  readonly version: string;
  readonly commit: string | null;
  readonly uptimeSec: number;
}

export interface HealthBody {
  readonly status: 'ok' | 'degraded' | 'draining';
  readonly version: string;
  readonly commit: string | null;
  readonly uptimeSec: number;
  readonly db: DatabaseStatus | 'skipped';
}

export interface HealthReport {
  readonly statusCode: 200 | 503;
  readonly body: HealthBody;
}

/**
 * Maps the relay's state to the `/health` answer (03 §5.12, 06 §5.5): 503 while
 * draining (D15) or when the database check fails, 200 otherwise.
 */
export function healthReport(input: HealthInput): HealthReport {
  const base = { version: input.version, commit: input.commit, uptimeSec: input.uptimeSec };
  if (input.draining || input.db === undefined) {
    return { statusCode: 503, body: { status: 'draining', ...base, db: 'skipped' } };
  }
  if (input.db === 'error') {
    return { statusCode: 503, body: { status: 'degraded', ...base, db: 'error' } };
  }
  return { statusCode: 200, body: { status: 'ok', ...base, db: input.db } };
}
