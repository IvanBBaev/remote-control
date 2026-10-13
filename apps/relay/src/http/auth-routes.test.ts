import { PGlite } from '@electric-sql/pglite';
import { sha256, utf8, webCryptoRandom } from '@remote-control/crypto';
import { createLogger, createMemoryDestination, type MemoryDestination } from '@remote-control/log';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDrizzleAccountStore } from '../adapters/drizzle-account-store.js';
import { createPgliteDb } from '../adapters/pglite-db.js';
import { createScryptSecretHasher } from '../adapters/scrypt-secret-hasher.js';
import { createSimpleWebAuthn } from '../adapters/simple-webauthn.js';
import { buildApp } from '../app.js';
import { AccountService, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from '../core/account-service.js';
import { DrainState } from '../core/drain-state.js';
import { mintInvites } from '../core/invites.js';
import { MIGRATIONS_DIR } from '../package-paths.js';
import type { AccountStore } from '../ports/account-store.js';
import type { Db } from '../ports/db.js';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '../ports/webauthn.js';
import { SoftwareAuthenticator } from '../testing/software-authenticator.js';
import { DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimits } from './auth-routes.js';

const RP_ID = 'rc.example.test';
const ORIGIN = 'https://rc.example.test';
const DAY = 24 * 60 * 60 * 1000;
const COOKIE_ATTRIBUTES = 'Path=/; Secure; HttpOnly; SameSite=Strict';
const PWA_HEADERS = { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'x-rc-client': 'pwa' };

function fakeClock(start = Date.UTC(2026, 9, 1)) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const client = new PGlite();
let db: Db;
let store: AccountStore;

beforeAll(async () => {
  db = createPgliteDb(client, { migrationsFolder: MIGRATIONS_DIR });
  await db.migrate();
  store = createDrizzleAccountStore(db.orm);
});

afterAll(() => client.close());

afterEach(() => {
  vi.restoreAllMocks();
});

interface Harness {
  readonly app: FastifyInstance;
  readonly clock: ReturnType<typeof fakeClock>;
  readonly logs: MemoryDestination;
  readonly authenticator: SoftwareAuthenticator;
  invite(ttlMs?: number): Promise<string>;
  post(
    url: string,
    body?: unknown,
    extra?: Record<string, string>,
  ): Promise<LightMyRequestResponse>;
  get(url: string, cookie?: string): Promise<LightMyRequestResponse>;
}

async function harness(
  options: { limits?: Partial<AuthRateLimits>; trustProxyHops?: number } = {},
): Promise<Harness> {
  const clock = fakeClock();
  const logs = createMemoryDestination();
  const service = new AccountService({
    store,
    webauthn: createSimpleWebAuthn({ id: RP_ID, origin: ORIGIN, name: 'remote-control' }),
    hasher: createScryptSecretHasher(webCryptoRandom),
    clock,
    random: webCryptoRandom,
  });
  const app = await buildApp({
    logger: createLogger({ level: 'info', destination: logs }),
    clock,
    database: db,
    drain: new DrainState(),
    version: '0.0.0',
    commit: null,
    publicDir: undefined,
    ...(options.trustProxyHops === undefined ? {} : { trustProxyHops: options.trustProxyHops }),
    auth: { service, origin: ORIGIN, limits: { ...DEFAULT_AUTH_RATE_LIMITS, ...options.limits } },
  });
  return {
    app,
    clock,
    logs,
    authenticator: new SoftwareAuthenticator(RP_ID, ORIGIN),
    invite: async (ttlMs = 7 * DAY) =>
      (await mintInvites({ store, clock, random: webCryptoRandom }, 1, ttlMs))[0]!,
    post: (url, body = {}, extra = {}) =>
      app.inject({
        method: 'POST',
        url,
        headers: { ...PWA_HEADERS, ...extra },
        payload: body as Record<string, unknown>,
      }),
    get: (url, cookie) =>
      app.inject({ method: 'GET', url, headers: cookie === undefined ? {} : { cookie } }),
  };
}

function cookieOf(res: LightMyRequestResponse): string {
  const header = res.headers['set-cookie'];
  expect(typeof header).toBe('string');
  return header as string;
}

function tokenOf(res: LightMyRequestResponse): string {
  return /^__Host-rc_session=([^;]+);/.exec(cookieOf(res))![1]!;
}

const cookieHeader = (token: string) => `__Host-rc_session=${token}`;

async function register(h: Harness, authenticator = h.authenticator) {
  const optionsRes = await h.post('/api/auth/register/options', {
    inviteCode: await h.invite(),
    displayName: 'Ivan',
  });
  expect(optionsRes.statusCode).toBe(200);
  const options = optionsRes.json<PublicKeyCredentialCreationOptionsJSON>();
  const res = await h.post('/api/auth/register/verify', await authenticator.create(options));
  expect(res.statusCode).toBe(200);
  const body = res.json<{ userId: string; recoveryCode: string; backedUp: boolean }>();
  return { ...body, token: tokenOf(res), options };
}

async function loginOptions(h: Harness) {
  const res = await h.post('/api/auth/login/options');
  expect(res.statusCode).toBe(200);
  return res.json<PublicKeyCredentialRequestOptionsJSON>();
}

async function auditEvents(userId: string): Promise<string[]> {
  const result = await client.query<{ event: string }>(
    'SELECT event FROM audit_log WHERE user_id = $1 ORDER BY id',
    [userId],
  );
  return result.rows.map((row) => row.event);
}

describe('registration', () => {
  it('registers with an invite: options per D8, cookie attributes, hashes only, audit row', async () => {
    const h = await harness();
    const inviteCode = await h.invite();
    const optionsRes = await h.post('/api/auth/register/options', { inviteCode });
    expect(optionsRes.statusCode).toBe(200);
    expect(optionsRes.headers['cache-control']).toBe('no-store');
    const options = optionsRes.json<PublicKeyCredentialCreationOptionsJSON>();
    expect(options.rp).toEqual({ name: 'remote-control', id: RP_ID });
    expect(options.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    });
    expect(options.attestation).toBe('none');
    expect(options.pubKeyCredParams).toEqual([{ alg: -7, type: 'public-key' }]);
    expect(options.user.name).toBe('remote-control');

    const res = await h.post('/api/auth/register/verify', await h.authenticator.create(options));
    expect(res.statusCode).toBe(200);
    const body = res.json<{ userId: string; recoveryCode: string; backedUp: boolean }>();
    expect(body.backedUp).toBe(true);
    expect(body.recoveryCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}-[0-9A-HJKMNP-TV-Z]{26}$/);

    const cookie = cookieOf(res);
    expect(cookie).toMatch(
      new RegExp(
        `^__Host-rc_session=[A-Za-z0-9_-]{43}; Max-Age=${SESSION_IDLE_MS / 1000}; ${COOKIE_ATTRIBUTES}$`,
      ),
    );
    expect(cookie).not.toMatch(/Domain=/i);

    const token = tokenOf(res);
    const sessions = await client.query<{ token_hash: Uint8Array; expires_at: Date }>(
      'SELECT token_hash, expires_at FROM sessions WHERE user_id = $1',
      [body.userId],
    );
    expect(sessions.rows).toHaveLength(1);
    expect([...sessions.rows[0]!.token_hash]).toEqual([...(await sha256(utf8(token)))]);
    expect(sessions.rows[0]!.expires_at.getTime()).toBe(h.clock.now() + SESSION_ABSOLUTE_MS);
    const recovery = await client.query<{ code_hash: string }>(
      'SELECT code_hash FROM recovery_codes WHERE user_id = $1',
      [body.userId],
    );
    expect(recovery.rows[0]!.code_hash).toMatch(/^scrypt\$N=32768,r=8,p=1\$/);
    expect(recovery.rows[0]!.code_hash).not.toContain(body.recoveryCode.slice(9));
    const invite = await client.query<{ used_by_user_id: string; used_at: Date }>(
      'SELECT used_by_user_id, used_at FROM invite_codes WHERE code_hash = $1',
      [await sha256(utf8(inviteCode))],
    );
    expect(invite.rows[0]).toMatchObject({ used_by_user_id: body.userId });
    const passkey = await client.query<{ device_type: string; backed_up: boolean }>(
      'SELECT device_type, backed_up FROM passkeys WHERE user_id = $1',
      [body.userId],
    );
    expect(passkey.rows).toEqual([{ device_type: 'multiDevice', backed_up: true }]);
    expect(await auditEvents(body.userId)).toEqual(['register']);

    const session = await h.get('/api/auth/session', cookieHeader(token));
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual({ userId: body.userId });

    const logged = h.logs.lines().join('\n');
    expect(logged).toContain('"event":"register"');
    for (const secret of [token, body.recoveryCode, inviteCode, options.challenge]) {
      expect(logged).not.toContain(secret);
    }
  });

  it('accepts a typed invite code in any case with dashes and spaces', async () => {
    const h = await harness();
    const code = await h.invite();
    const typed = `${code.slice(0, 5).toLowerCase()} - ${code.slice(5)}`;
    expect((await h.post('/api/auth/register/options', { inviteCode: typed })).statusCode).toBe(
      200,
    );
  });

  it('rejects an invalid invite: unknown, malformed, used and expired', async () => {
    const h = await harness();
    const unknown = await h.post('/api/auth/register/options', {
      inviteCode: '0123456789ABCDEFGHJKMNPQRS',
    });
    expect(unknown.statusCode).toBe(403);
    expect(unknown.json()).toEqual({ error: 'invalid_invite' });
    expect(
      (await h.post('/api/auth/register/options', { inviteCode: 'not-an-invite!' })).statusCode,
    ).toBe(403);
    expect((await h.post('/api/auth/register/options', { inviteCode: 'ABC' })).statusCode).toBe(
      403,
    );

    const used = await h.invite();
    const options = (
      await h.post('/api/auth/register/options', { inviteCode: used })
    ).json<PublicKeyCredentialCreationOptionsJSON>();
    await h.post('/api/auth/register/verify', await h.authenticator.create(options));
    expect((await h.post('/api/auth/register/options', { inviteCode: used })).statusCode).toBe(403);

    const expiring = await h.invite(DAY);
    h.clock.advance(DAY);
    expect((await h.post('/api/auth/register/options', { inviteCode: expiring })).statusCode).toBe(
      403,
    );
  });

  it('consumes the invite once when two registrations race on it', async () => {
    const h = await harness();
    const inviteCode = await h.invite();
    const first = (
      await h.post('/api/auth/register/options', { inviteCode })
    ).json<PublicKeyCredentialCreationOptionsJSON>();
    const second = (
      await h.post('/api/auth/register/options', { inviteCode })
    ).json<PublicKeyCredentialCreationOptionsJSON>();
    const other = new SoftwareAuthenticator(RP_ID, ORIGIN);
    expect(
      (await h.post('/api/auth/register/verify', await h.authenticator.create(first))).statusCode,
    ).toBe(200);
    const res = await h.post('/api/auth/register/verify', await other.create(second));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'invalid_invite' });
  });

  it('rejects a replayed registration response', async () => {
    const h = await harness();
    const options = (
      await h.post('/api/auth/register/options', { inviteCode: await h.invite() })
    ).json<PublicKeyCredentialCreationOptionsJSON>();
    const response = await h.authenticator.create(options);
    expect((await h.post('/api/auth/register/verify', response)).statusCode).toBe(200);
    const replay = await h.post('/api/auth/register/verify', response);
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toEqual({ error: 'unknown_challenge' });
  });

  it('rejects a wrong origin in clientDataJSON, missing UV and an expired challenge', async () => {
    const h = await harness();
    const options = async () =>
      (
        await h.post('/api/auth/register/options', { inviteCode: await h.invite() })
      ).json<PublicKeyCredentialCreationOptionsJSON>();
    const wrongOrigin = await h.post(
      '/api/auth/register/verify',
      await h.authenticator.create(await options(), { origin: 'https://evil.example' }),
    );
    expect(wrongOrigin.statusCode).toBe(400);
    expect(wrongOrigin.json()).toEqual({ error: 'verification_failed' });
    const noUv = await h.post(
      '/api/auth/register/verify',
      await h.authenticator.create(await options(), { userVerified: false }),
    );
    expect(noUv.statusCode).toBe(400);
    const late = await options();
    h.clock.advance(5 * 60_000);
    const expired = await h.post('/api/auth/register/verify', await h.authenticator.create(late));
    expect(expired.json()).toEqual({ error: 'unknown_challenge' });
  });

  it('answers 400 to malformed bodies and to a login challenge used for registration', async () => {
    const h = await harness();
    expect((await h.post('/api/auth/register/options', { inviteCode: 1 })).statusCode).toBe(400);
    expect(
      (await h.post('/api/auth/register/options', { inviteCode: 'x', extra: true })).statusCode,
    ).toBe(400);
    expect((await h.post('/api/auth/register/verify', { id: 'x' })).statusCode).toBe(400);
    const login = await loginOptions(h);
    const crossed = await h.authenticator.create({
      ...(
        await h.post('/api/auth/register/options', { inviteCode: await h.invite() })
      ).json<PublicKeyCredentialCreationOptionsJSON>(),
      challenge: login.challenge,
    });
    expect((await h.post('/api/auth/register/verify', crossed)).json()).toEqual({
      error: 'unknown_challenge',
    });
    const garbled = await h.authenticator.create(
      (
        await h.post('/api/auth/register/options', { inviteCode: await h.invite() })
      ).json<PublicKeyCredentialCreationOptionsJSON>(),
    );
    const res = await h.post('/api/auth/register/verify', {
      ...garbled,
      response: { ...garbled.response, clientDataJSON: 'AAAA' },
    });
    expect(res.json()).toEqual({ error: 'unknown_challenge' });
  });
});

describe('login', () => {
  it('logs in with a discoverable credential and records the login', async () => {
    const h = await harness();
    const account = await register(h);
    const options = await loginOptions(h);
    expect(options.rpId).toBe(RP_ID);
    expect(options.userVerification).toBe('required');
    expect(options.allowCredentials ?? []).toEqual([]);
    const res = await h.post('/api/auth/login/verify', await h.authenticator.get(options));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: account.userId });
    expect(cookieOf(res)).toMatch(new RegExp(`; Max-Age=604800; ${COOKIE_ATTRIBUTES}$`));
    expect(tokenOf(res)).not.toBe(account.token);
    const counter = await client.query<{ counter: string | number }>(
      'SELECT counter FROM passkeys WHERE user_id = $1',
      [account.userId],
    );
    expect(Number(counter.rows[0]!.counter)).toBe(1);
    expect(await auditEvents(account.userId)).toEqual(['register', 'login']);
  });

  it('rejects a replayed login response', async () => {
    const h = await harness();
    await register(h);
    const response = await h.authenticator.get(await loginOptions(h));
    expect((await h.post('/api/auth/login/verify', response)).statusCode).toBe(200);
    const replay = await h.post('/api/auth/login/verify', response);
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toEqual({ error: 'unknown_challenge' });
  });

  it('answers 401 for a wrong origin, a missing UV flag, a foreign user handle or an unknown credential', async () => {
    const h = await harness();
    await register(h);
    const attempt = async (overrides: Parameters<SoftwareAuthenticator['get']>[1]) =>
      h.post('/api/auth/login/verify', await h.authenticator.get(await loginOptions(h), overrides));
    const wrongOrigin = await attempt({ origin: 'https://evil.example' });
    expect(wrongOrigin.statusCode).toBe(401);
    expect(wrongOrigin.json()).toEqual({ error: 'verification_failed' });
    expect((await attempt({ userVerified: false })).statusCode).toBe(401);
    expect((await attempt({ userHandle: 'AAAA' })).statusCode).toBe(401);
    const stranger = new SoftwareAuthenticator(RP_ID, ORIGIN);
    await stranger.create(
      (
        await h.post('/api/auth/register/options', { inviteCode: await h.invite() })
      ).json<PublicKeyCredentialCreationOptionsJSON>(),
    );
    const unknown = await h.post(
      '/api/auth/login/verify',
      await stranger.get(await loginOptions(h)),
    );
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual({ error: 'unknown_credential' });
  });
});

describe('origin guard', () => {
  it('answers 403 without Origin, with a foreign Origin, cross-site or without X-RC-Client', async () => {
    const h = await harness();
    const url = '/api/auth/login/options';
    const bare = await h.app.inject({ method: 'POST', url, payload: {} });
    expect(bare.statusCode).toBe(403);
    expect(bare.json()).toEqual({ error: 'forbidden' });
    expect((await h.post(url, {}, { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await h.post(url, {}, { origin: 'http://rc.example.test' })).statusCode).toBe(403);
    expect((await h.post(url, {}, { 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    expect((await h.post(url, {}, { 'sec-fetch-site': 'same-site' })).statusCode).toBe(403);
    expect((await h.post(url, {}, { 'x-rc-client': 'curl' })).statusCode).toBe(403);
    // Older browsers omit Sec-Fetch-Site; Origin + X-RC-Client still apply.
    const noFetchMetadata = await h.app.inject({
      method: 'POST',
      url,
      headers: { origin: ORIGIN, 'x-rc-client': 'pwa' },
      payload: {},
    });
    expect(noFetchMetadata.statusCode).toBe(200);
    expect(h.logs.lines().join('\n')).toContain('"reason":"origin_missing"');
  });
});

describe('sessions', () => {
  it('slides the idle window and expires after 7 idle days', async () => {
    const h = await harness();
    const { token } = await register(h);
    h.clock.advance(6 * DAY);
    const alive = await h.get('/api/auth/session', cookieHeader(token));
    expect(alive.statusCode).toBe(200);
    expect(cookieOf(alive)).toBe(
      `__Host-rc_session=${token}; Max-Age=${SESSION_IDLE_MS / 1000}; ${COOKIE_ATTRIBUTES}`,
    );
    h.clock.advance(SESSION_IDLE_MS);
    const expired = await h.get('/api/auth/session', cookieHeader(token));
    expect(expired.statusCode).toBe(401);
    expect(cookieOf(expired)).toBe(`__Host-rc_session=; Max-Age=0; ${COOKIE_ATTRIBUTES}`);
    expect(h.logs.lines().join('\n')).toContain('"reason":"expired"');
  });

  it('expires 30 days after login even when used daily', async () => {
    const h = await harness();
    const { token } = await register(h);
    for (let day = 0; day < 29; day += 1) {
      h.clock.advance(DAY);
      expect((await h.get('/api/auth/session', cookieHeader(token))).statusCode).toBe(200);
    }
    h.clock.advance(DAY / 2);
    const last = await h.get('/api/auth/session', cookieHeader(token));
    expect(last.statusCode).toBe(200);
    // Max-Age never outlives the absolute expiry.
    expect(cookieOf(last)).toContain(`Max-Age=${DAY / 2 / 1000};`);
    h.clock.advance(DAY / 2);
    expect((await h.get('/api/auth/session', cookieHeader(token))).statusCode).toBe(401);
  });

  it('answers 401 without a cookie or with an unknown or malformed token', async () => {
    const h = await harness();
    expect((await h.get('/api/auth/session')).statusCode).toBe(401);
    expect((await h.get('/api/auth/session', cookieHeader('A'.repeat(43)))).statusCode).toBe(401);
    expect((await h.get('/api/auth/session', cookieHeader('short'))).statusCode).toBe(401);
    expect((await h.get('/api/auth/session', 'other=1; theme=dark')).statusCode).toBe(401);
  });

  it('logs out: revokes the session, clears the cookie and writes the audit row', async () => {
    const h = await harness();
    const { token, userId } = await register(h);
    const res = await h.post('/api/auth/logout', {}, { cookie: cookieHeader(token) });
    expect(res.statusCode).toBe(204);
    expect(cookieOf(res)).toBe(`__Host-rc_session=; Max-Age=0; ${COOKIE_ATTRIBUTES}`);
    expect((await h.get('/api/auth/session', cookieHeader(token))).statusCode).toBe(401);
    expect((await h.post('/api/auth/logout', {}, { cookie: cookieHeader(token) })).statusCode).toBe(
      401,
    );
    expect(await auditEvents(userId)).toEqual(['register', 'session_revoked']);
    expect(h.logs.lines().join('\n')).toContain('"reason":"revoked"');
  });
});

describe('recovery', () => {
  it('registers a new passkey with the code once, rotates it and ends old sessions', async () => {
    const h = await harness();
    const account = await register(h);
    const phone = new SoftwareAuthenticator(RP_ID, ORIGIN);
    const optionsRes = await h.post('/api/auth/recovery/options', {
      recoveryCode: account.recoveryCode.toLowerCase(),
    });
    expect(optionsRes.statusCode).toBe(200);
    const options = optionsRes.json<PublicKeyCredentialCreationOptionsJSON>();
    expect(options.user.id).toBe(account.options.user.id);
    expect(options.excludeCredentials).toHaveLength(1);
    const res = await h.post('/api/auth/recovery/verify', await phone.create(options));
    expect(res.statusCode).toBe(200);
    const body = res.json<{ userId: string; recoveryCode: string }>();
    expect(body.userId).toBe(account.userId);
    expect(body.recoveryCode).not.toBe(account.recoveryCode);
    expect(cookieOf(res)).toContain(COOKIE_ATTRIBUTES);

    expect((await h.get('/api/auth/session', cookieHeader(account.token))).statusCode).toBe(401);
    expect((await h.get('/api/auth/session', cookieHeader(tokenOf(res)))).statusCode).toBe(200);
    const reused = await h.post('/api/auth/recovery/options', {
      recoveryCode: account.recoveryCode,
    });
    expect(reused.statusCode).toBe(403);
    expect(reused.json()).toEqual({ error: 'invalid_code' });
    const login = await h.post('/api/auth/login/verify', await phone.get(await loginOptions(h)));
    expect(login.json()).toEqual({ userId: account.userId });
    expect(await auditEvents(account.userId)).toEqual(['register', 'recovery', 'login']);
    expect(h.logs.lines().join('\n')).not.toContain(body.recoveryCode);
  });

  it('rejects a wrong secret, an unknown locator and a malformed code', async () => {
    const h = await harness();
    const { recoveryCode } = await register(h);
    const wrongSecret = `${recoveryCode.slice(0, 9)}${'0'.repeat(26)}`;
    for (const code of [wrongSecret, `ZZZZZZZZ-${recoveryCode.slice(9)}`, 'nope']) {
      const res = await h.post('/api/auth/recovery/options', { recoveryCode: code });
      expect(res.statusCode).toBe(403);
    }
  });

  it('rejects a code whose user is gone', async () => {
    const h = await harness();
    const { recoveryCode } = await register(h);
    vi.spyOn(store, 'findUser').mockResolvedValueOnce(undefined);
    const res = await h.post('/api/auth/recovery/options', { recoveryCode });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'invalid_code' });
  });

  it('uses the code once even when two recoveries race', async () => {
    const h = await harness();
    const { recoveryCode } = await register(h);
    const first = (
      await h.post('/api/auth/recovery/options', { recoveryCode })
    ).json<PublicKeyCredentialCreationOptionsJSON>();
    const second = (
      await h.post('/api/auth/recovery/options', { recoveryCode })
    ).json<PublicKeyCredentialCreationOptionsJSON>();
    const a = new SoftwareAuthenticator(RP_ID, ORIGIN);
    const b = new SoftwareAuthenticator(RP_ID, ORIGIN);
    expect((await h.post('/api/auth/recovery/verify', await a.create(first))).statusCode).toBe(200);
    const late = await h.post('/api/auth/recovery/verify', await b.create(second));
    expect(late.statusCode).toBe(403);
    expect(late.json()).toEqual({ error: 'invalid_code' });
  });

  it('rejects a failed or replayed recovery ceremony', async () => {
    const h = await harness();
    const { recoveryCode } = await register(h);
    const options = (
      await h.post('/api/auth/recovery/options', { recoveryCode })
    ).json<PublicKeyCredentialCreationOptionsJSON>();
    const phone = new SoftwareAuthenticator(RP_ID, ORIGIN);
    const noUv = await h.post(
      '/api/auth/recovery/verify',
      await phone.create(options, { userVerified: false }),
    );
    expect(noUv.statusCode).toBe(400);
    expect(noUv.json()).toEqual({ error: 'verification_failed' });
    const replay = await h.post('/api/auth/recovery/verify', await phone.create(options));
    expect(replay.json()).toEqual({ error: 'unknown_challenge' });
  });
});

describe('rate limits', () => {
  it('allows 5 registration attempts per IP and hour, then 429 with Retry-After', async () => {
    const h = await harness();
    for (let i = 0; i < 5; i += 1) {
      expect((await h.post('/api/auth/register/options', { inviteCode: 'X' })).statusCode).toBe(
        403,
      );
    }
    const limited = await h.post('/api/auth/register/options', { inviteCode: await h.invite() });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('3600');
    expect(limited.json()).toEqual({ error: 'rate_limited' });
    const elsewhere = await h.app.inject({
      method: 'POST',
      url: '/api/auth/register/options',
      headers: PWA_HEADERS,
      remoteAddress: '203.0.113.9',
      payload: { inviteCode: 'X' },
    });
    expect(elsewhere.statusCode).toBe(403);
    h.clock.advance(60 * 60_000);
    expect((await h.post('/api/auth/register/options', { inviteCode: 'X' })).statusCode).toBe(403);
  });

  it('limits every auth request per IP, keyed by the trusted proxy hop', async () => {
    const h = await harness({
      limits: { anyPerIp: { max: 2, windowMs: 60_000 } },
      trustProxyHops: 1,
    });
    const from = (ip: string) =>
      h.app.inject({
        method: 'POST',
        url: '/api/auth/login/options',
        headers: { ...PWA_HEADERS, 'x-forwarded-for': ip },
        payload: {},
      });
    expect((await from('198.51.100.1')).statusCode).toBe(200);
    expect((await from('198.51.100.1')).statusCode).toBe(200);
    expect((await from('198.51.100.1')).statusCode).toBe(429);
    expect((await from('198.51.100.2')).statusCode).toBe(200);
  });

  it('limits login verification per IP and per account', async () => {
    const h = await harness({
      limits: {
        loginPerIp: { max: 3, windowMs: 60_000 },
        loginPerUser: { max: 1, windowMs: 60_000 },
      },
    });
    await register(h);
    expect(
      (await h.post('/api/auth/login/verify', await h.authenticator.get(await loginOptions(h))))
        .statusCode,
    ).toBe(200);
    const perUser = await h.post(
      '/api/auth/login/verify',
      await h.authenticator.get(await loginOptions(h)),
    );
    expect(perUser.statusCode).toBe(429);
    expect(perUser.headers['retry-after']).toBe('60');
    expect((await h.post('/api/auth/login/verify', { id: 'x' })).statusCode).toBe(400);
    expect((await h.post('/api/auth/login/verify', { id: 'x' })).statusCode).toBe(429);
  });

  it('limits recovery per IP and per account, and authenticated requests per account', async () => {
    const h = await harness({
      limits: {
        recoveryPerIp: { max: 2, windowMs: 60_000 },
        recoveryPerUser: { max: 1, windowMs: 60_000 },
        sessionPerUser: { max: 1, windowMs: 60_000 },
      },
    });
    const { recoveryCode, token } = await register(h);
    const wrong = `${recoveryCode.slice(0, 9)}${'0'.repeat(26)}`;
    expect((await h.post('/api/auth/recovery/options', { recoveryCode: wrong })).statusCode).toBe(
      403,
    );
    expect((await h.post('/api/auth/recovery/options', { recoveryCode })).statusCode).toBe(429);
    expect((await h.post('/api/auth/recovery/options', { recoveryCode })).statusCode).toBe(429);
    expect((await h.post('/api/auth/recovery/options', { recoveryCode: 1 })).statusCode).toBe(429);
    expect((await h.get('/api/auth/session', cookieHeader(token))).statusCode).toBe(200);
    expect((await h.get('/api/auth/session', cookieHeader(token))).statusCode).toBe(429);
  });
});
