// The `.p8` key is checked synchronously while the config loads, and the provider token is
// an ES256 JWS for Apple, not E2E material (D3 covers phone ↔ agent crypto), so this
// relay-only adapter uses node:crypto like the scrypt hasher.
// eslint-disable-next-line no-restricted-imports -- synchronous PKCS#8 parsing for config validation.
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import http2 from 'node:http2';

import type { ApnsEnvironment, ApnsPort, PushResult } from '../ports/push.js';
import { systemClock } from './system-clock.js';

/** Token-based provider auth (ADR 0017): the `.p8` signing key from the environment. */
export interface ApnsConfig {
  /** The `.p8` key's PEM (PKCS#8, EC P-256); a secret (D19). */
  readonly privateKey: string;
  /** The key's 10-character id from the developer account. */
  readonly keyId: string;
  /** The 10-character Apple Developer team id. */
  readonly teamId: string;
  /** `apns-topic`: the app's bundle id. */
  readonly topic: string;
}

export interface ApnsSenderOptions {
  /** Abort a request after this long; default 10 s. */
  readonly timeoutMs?: number;
  /** Server origins; tests point them at a local h2c server. */
  readonly origins?: Readonly<Record<ApnsEnvironment, string>>;
  /** Epoch milliseconds, for the JWT `iat`; default the system clock. */
  readonly now?: () => number;
}

export interface ApnsSender extends ApnsPort {
  /** Closes the HTTP/2 connections (shutdown). */
  close(): void;
}

export const APNS_ORIGINS: Readonly<Record<ApnsEnvironment, string>> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

/** APNs refuses a provider token older than an hour and throttles refreshes under 20 min. */
const TOKEN_REFRESH_MS = 40 * 60_000;

/** Device tokens are hex; anything else never reaches the request path. */
const DEVICE_TOKEN = /^[0-9a-f]{64,200}$/i;

/** 400 reasons that mean the token will never work for this app again. */
const GONE_REASONS = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered']);

/** 403 reasons that mean the cached provider token must be re-signed. */
const STALE_TOKEN_REASONS = new Set(['ExpiredProviderToken', 'InvalidProviderToken']);

const base64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

/** Parses the `.p8` PEM; throws if it is not an EC P-256 private key. */
export function parseApnsKey(pem: string): KeyObject {
  const key = createPrivateKey(pem.replaceAll('\\n', '\n'));
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('APNs key must be an EC P-256 private key');
  }
  return key;
}

/** The ES256 provider token `{alg, kid}.{iss, iat}` (JOSE signature, not DER). */
export function apnsProviderToken(
  key: KeyObject,
  keyId: string,
  teamId: string,
  nowMs: number,
): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims = base64url(JSON.stringify({ iss: teamId, iat: Math.floor(nowMs / 1000) }));
  const input = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${base64url(signature)}`;
}

interface Response {
  readonly status: number | null;
  readonly reason: string | undefined;
}

/**
 * The {@link ApnsPort} over `node:http2` (M4-05): one long-lived, unref'd connection per
 * environment, a cached provider token, and `POST /3/device/<token>` alerts. Errors become
 * results — never exceptions, never logged tokens (D19); `gone` (410, or a bad / foreign
 * token) lets the notifier delete the subscription.
 */
export function createApnsSender(config: ApnsConfig, options: ApnsSenderOptions = {}): ApnsSender {
  const key = parseApnsKey(config.privateKey);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const origins = options.origins ?? APNS_ORIGINS;
  const now = options.now ?? (() => systemClock.now());
  const sessions = new Map<string, http2.ClientHttp2Session>();
  let cached: { token: string; issuedAt: number } | undefined;

  const providerToken = () => {
    const at = now();
    if (cached === undefined || at - cached.issuedAt >= TOKEN_REFRESH_MS) {
      cached = { token: apnsProviderToken(key, config.keyId, config.teamId, at), issuedAt: at };
    }
    return cached.token;
  };

  const session = (origin: string) => {
    const open = sessions.get(origin);
    if (open !== undefined && !open.closed && !open.destroyed) return open;
    const fresh = http2.connect(origin);
    fresh.on('error', () => fresh.destroy());
    fresh.on('close', () => {
      if (sessions.get(origin) === fresh) sessions.delete(origin);
    });
    fresh.unref();
    sessions.set(origin, fresh);
    return fresh;
  };

  const post = (
    origin: string,
    headers: http2.OutgoingHttpHeaders,
    body: string,
  ): Promise<Response> =>
    new Promise((resolve) => {
      let settled = false;
      const done = (response: Response) => {
        if (settled) return;
        settled = true;
        resolve(response);
      };
      let request: http2.ClientHttp2Stream;
      try {
        request = session(origin).request(headers);
      } catch {
        done({ status: null, reason: undefined });
        return;
      }
      let status: number | null = null;
      const chunks: Buffer[] = [];
      request.setTimeout(timeoutMs, () => {
        request.close(http2.constants.NGHTTP2_CANCEL);
        done({ status: null, reason: undefined });
      });
      request.on('response', (head) => {
        status = Number(head[':status']);
      });
      request.on('data', (chunk: Buffer) => {
        if (chunks.length < 8) chunks.push(chunk);
      });
      request.on('end', () => done({ status, reason: reasonOf(chunks) }));
      request.on('error', () => done({ status: null, reason: undefined }));
      request.on('close', () => done({ status, reason: reasonOf(chunks) }));
      request.end(body);
    });

  return {
    async send(target, message): Promise<PushResult> {
      if (!DEVICE_TOKEN.test(target.token)) return { kind: 'gone' };
      let authorization: string;
      try {
        authorization = `bearer ${providerToken()}`;
      } catch {
        return { kind: 'failed', status: null };
      }
      const { status, reason } = await post(
        origins[target.environment],
        {
          ':method': 'POST',
          ':path': `/3/device/${target.token}`,
          authorization,
          'apns-topic': config.topic,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-expiration': String(message.expiration),
          'apns-collapse-id': message.collapseId,
          'content-type': 'application/json',
        },
        message.payload,
      );
      if (status === 200) return { kind: 'sent' };
      if (status === 410) return { kind: 'gone' };
      if (status === 400 && reason !== undefined && GONE_REASONS.has(reason)) {
        return { kind: 'gone' };
      }
      if (status === 403 && reason !== undefined && STALE_TOKEN_REASONS.has(reason)) {
        cached = undefined;
      }
      return { kind: 'failed', status };
    },

    close() {
      for (const open of sessions.values()) open.close();
      sessions.clear();
    },
  };
}

/** APNs error bodies are `{"reason": "..."}`; only the reason is kept. */
function reasonOf(chunks: readonly Buffer[]): string | undefined {
  if (chunks.length === 0) return undefined;
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { reason?: unknown };
    return typeof body.reason === 'string' ? body.reason : undefined;
  } catch {
    return undefined;
  }
}
