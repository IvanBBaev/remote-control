import { DeviceId, EpochMs } from '@remote-control/protocol';
import { z } from 'zod';

import type { RelayApi, RelayResult } from '../ports/relay-api.js';
import type { FetchFn } from './npm-registry.js';

const TIMEOUT_MS = 10_000;

const SlotIdSchema = z.uuid();
const TokenBody = z.object({
  token: z.string().min(1).max(512),
  userId: z.uuid().regex(/^[0-9a-f-]+$/),
});
const OpenedBody = z.object({ slotId: SlotIdSchema, expiresAt: EpochMs });
const StatusBody = z.object({
  slotId: SlotIdSchema,
  state: z.enum(['open', 'joined', 'expired', 'closed']),
  phoneDeviceId: DeviceId.nullable(),
  failedAttempts: z.int().nonnegative(),
  expiresAt: EpochMs,
});
const CompletedBody = z.object({ pairingId: z.string().min(1).max(128), phoneDeviceId: DeviceId });
const FailedBody = z.object({
  state: z.enum(['open', 'closed']),
  failedAttempts: z.int().nonnegative(),
});
const ErrorBody = z.object({ error: z.string().max(64) });

export interface RelayHttpOptions {
  /** The relay origin, e.g. `https://relay.example.com`. */
  readonly baseUrl: string;
  /** The agent's bearer token (the enrol token without `rc-enroll:` for the first rotation). */
  readonly token: string;
  readonly fetch: FetchFn;
}

/**
 * `RelayApi` over `fetch` (M0-10 routes under `/api`, plus the relay's `/health`). Every call carries the agent's
 * bearer token, refuses redirects and times out after 10 s; bodies are validated, and
 * anything unexpected becomes a failed result instead of an exception.
 */
export function createRelayHttp(options: RelayHttpOptions): RelayApi {
  async function call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    schema: z.ZodType<T> | null,
    body?: unknown,
  ): Promise<RelayResult<T>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${options.token}`,
      accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await options.fetch(new URL(path, options.baseUrl).href, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return { ok: false, status: 0, error: 'network' };
    }
    let json: unknown = null;
    try {
      if (response.status !== 204) json = await response.json();
    } catch {
      json = null;
    }
    if (!response.ok) {
      const parsed = ErrorBody.safeParse(json);
      return {
        ok: false,
        status: response.status,
        error: parsed.success ? parsed.data.error : 'bad_response',
      };
    }
    if (schema === null) return { ok: true, value: null as T };
    const parsed = schema.safeParse(json);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, status: response.status, error: 'bad_response' };
  }

  const slot = (slotId: string): string => `/api/pairings/${encodeURIComponent(slotId)}`;

  return {
    rotateToken: () => call('POST', '/api/agents/token', TokenBody),
    openSlot: (codeHash) => call('POST', '/api/pairings', OpenedBody, { codeHash }),
    slotStatus: (slotId) => call('GET', slot(slotId), StatusBody),
    completeSlot: (slotId) => call('POST', `${slot(slotId)}/complete`, CompletedBody),
    failSlot: (slotId) => call('POST', `${slot(slotId)}/fail`, FailedBody),
    cancelSlot: (slotId) => call('DELETE', slot(slotId), null),
    health: () => call('GET', '/health', null),
  };
}
