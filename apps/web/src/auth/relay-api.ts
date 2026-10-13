import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';

/** The relay answered with an error status; `reason` is its `{ error }` code. */
export class RelayError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    /** Seconds from `retry-after` on a 429. */
    readonly retryAfterSec?: number,
  ) {
    super(`relay answered ${String(status)} ${reason}`);
    this.name = 'RelayError';
  }
}

/** The request never got an answer (offline, DNS, TLS). */
export class OfflineError extends Error {
  constructor(options?: ErrorOptions) {
    super('the relay is unreachable', options);
    this.name = 'OfflineError';
  }
}

export interface Registered {
  readonly userId: string;
  /** Shown once; the relay keeps only its hash (D8). */
  readonly recoveryCode: string;
  /** The passkey is synced by the platform (backup state flag). */
  readonly backedUp: boolean;
}

export interface VerifiedDecision {
  readonly decisionHash: string;
  /** Unix ms until which the relay admits the matching command envelope. */
  readonly verifiedUntil: number;
}

/** The relay's `/api/auth/*` and `/api/decisions/*` endpoints, as the PWA calls them. */
export interface RelayApi {
  registerOptions(input: {
    inviteCode: string;
    displayName?: string;
  }): Promise<PublicKeyCredentialCreationOptionsJSON>;
  registerVerify(response: RegistrationResponseJSON): Promise<Registered>;
  loginOptions(): Promise<PublicKeyCredentialRequestOptionsJSON>;
  loginVerify(response: AuthenticationResponseJSON): Promise<{ userId: string }>;
  /** The signed-in user, or `null` when the session cookie is missing or revoked. */
  session(): Promise<{ userId: string } | null>;
  logout(): Promise<void>;
  decisionChallenge(decisionHash: string): Promise<PublicKeyCredentialRequestOptionsJSON>;
  decisionVerify(response: AuthenticationResponseJSON): Promise<VerifiedDecision>;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

async function reasonOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * `fetch` against the relay on the same origin. Every call carries `X-RC-Client: pwa`,
 * which the relay's origin guard requires on state-changing requests (D8); the session
 * travels in the `__Host-` cookie, never in script-visible storage.
 */
export function createRelayApi(
  fetchImpl: FetchLike,
  { baseUrl = '', timeoutMs = 15_000 }: { baseUrl?: string; timeoutMs?: number } = {},
): RelayApi {
  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { 'x-rc-client': 'pwa' };
    // Fastify rejects an empty body declared as JSON, so a call without a body sends none.
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        // A hung request (captive portal, dead socket) reads as offline, not as a spinner.
        signal: AbortSignal.timeout(timeoutMs),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new OfflineError({ cause: error });
    }
    if (response.ok) return response;
    const retryAfter = Number(response.headers.get('retry-after'));
    throw new RelayError(
      response.status,
      await reasonOf(response),
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }

  async function json<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    return (await (await call(method, path, body)).json()) as T;
  }

  return {
    registerOptions: (input) => json('POST', '/api/auth/register/options', input),
    registerVerify: (response) => json('POST', '/api/auth/register/verify', response),
    loginOptions: () => json('POST', '/api/auth/login/options'),
    loginVerify: (response) => json('POST', '/api/auth/login/verify', response),
    async session() {
      try {
        return await json<{ userId: string }>('GET', '/api/auth/session');
      } catch (error) {
        if (error instanceof RelayError && error.status === 401) return null;
        throw error;
      }
    },
    async logout() {
      await call('POST', '/api/auth/logout');
    },
    decisionChallenge: (decisionHash) => json('POST', '/api/decisions/challenge', { decisionHash }),
    decisionVerify: (response) => json('POST', '/api/decisions/verify', { response }),
  };
}
