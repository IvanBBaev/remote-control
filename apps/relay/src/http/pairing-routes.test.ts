import { PGlite } from '@electric-sql/pglite';
import { sha256, utf8, webCryptoRandom } from '@remote-control/crypto';
import { createLogger, createMemoryDestination, type MemoryDestination } from '@remote-control/log';
import { toBase64Url, toHex } from '@remote-control/protocol';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createDrizzleAccountStore } from '../adapters/drizzle-account-store.js';
import { createDrizzleDeviceDirectory } from '../adapters/drizzle-device-directory.js';
import { createDrizzleDeviceRegistry } from '../adapters/drizzle-device-registry.js';
import { createPgliteDb } from '../adapters/pglite-db.js';
import { createScryptSecretHasher } from '../adapters/scrypt-secret-hasher.js';
import { createSimpleWebAuthn } from '../adapters/simple-webauthn.js';
import { buildApp } from '../app.js';
import { AccountService } from '../core/account-service.js';
import { DecisionVerifier, VERIFIED_TTL_MS } from '../core/decision-verifier.js';
import { DrainState } from '../core/drain-state.js';
import { DEVICE_CAP } from '../core/hub-limits.js';
import { mintInvites } from '../core/invites.js';
import { LocalHub } from '../core/local-hub.js';
import {
  ENROLL_TOKEN_PREFIX,
  HANDSHAKE_GRACE_MS,
  PairingService,
  SLOT_TTL_MS,
} from '../core/pairing-service.js';
import { RelayRouter } from '../core/relay-router.js';
import { devices, pairingSlots, pairings, passkeys, sessions } from '../db/schema.js';
import { MIGRATIONS_DIR } from '../package-paths.js';
import type { AccountStore } from '../ports/account-store.js';
import type { Db } from '../ports/db.js';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '../ports/webauthn.js';
import { createFakeTime, type FakeTime } from '../testing/fake-time.js';
import { SoftwareAuthenticator } from '../testing/software-authenticator.js';
import { WsPeer } from '../testing/ws-peer.js';
import { DEFAULT_PAIRING_RATE_LIMITS, type PairingRateLimits } from './pairing-routes.js';

const RP_ID = 'rc.example.test';
const ORIGIN = 'https://rc.example.test';
const DAY = 24 * 60 * 60 * 1000;
const PWA_HEADERS = { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'x-rc-client': 'pwa' };

const client = new PGlite();
let db: Db;
let store: AccountStore;

beforeAll(async () => {
  db = createPgliteDb(client, { migrationsFolder: MIGRATIONS_DIR });
  await db.migrate();
  store = createDrizzleAccountStore(db.orm);
});

afterAll(() => client.close());

interface Relay {
  readonly app: FastifyInstance;
  readonly url: string;
  readonly time: FakeTime;
  readonly logs: MemoryDestination;
}

const running: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((app) => app.close()));
});

async function startRelay(limits: Partial<PairingRateLimits> = {}): Promise<Relay> {
  const time = createFakeTime();
  const logs = createMemoryDestination();
  const logger = createLogger({ level: 'info', destination: logs });
  const directory = createDrizzleDeviceDirectory(db.orm);
  const hub = new LocalHub(time.clock, DEVICE_CAP);
  const webauthn = createSimpleWebAuthn({ id: RP_ID, origin: ORIGIN, name: 'remote-control' });
  const decisions = new DecisionVerifier({ store, webauthn, clock: time.clock });
  const router = new RelayRouter({
    clock: time.clock,
    timer: time.timer,
    hub,
    directory,
    logger,
    commandGate: decisions,
  });
  const service = new AccountService({
    store,
    webauthn,
    hasher: createScryptSecretHasher(webCryptoRandom),
    clock: time.clock,
    random: webCryptoRandom,
  });
  const pairing = new PairingService({
    registry: createDrizzleDeviceRegistry(db.orm),
    clock: time.clock,
    random: webCryptoRandom,
    deviceCap: DEVICE_CAP,
  });
  const app = await buildApp({
    logger,
    clock: time.clock,
    database: db,
    drain: new DrainState(),
    version: '0.0.0',
    commit: null,
    publicDir: undefined,
    auth: { service, origin: ORIGIN },
    relay: {
      router,
      hub,
      directory,
      pairing,
      decisions,
      pairingLimits: { ...DEFAULT_PAIRING_RATE_LIMITS, ...limits },
    },
  });
  running.push(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { app, url: `ws://127.0.0.1:${address.port}/ws`, time, logs };
}

const cookieOf = (token: string) => `__Host-rc_session=${token}`;

function sessionToken(res: LightMyRequestResponse): string {
  return /^__Host-rc_session=([^;]+);/.exec(res.headers['set-cookie'] as string)![1]!;
}

/** A phone-side caller: the PWA headers plus a login session cookie. */
function phoneCall(relay: Relay, cookie: string) {
  return (url: string, body: unknown = {}, extra: Record<string, string> = {}) =>
    relay.app.inject({
      method: 'POST',
      url,
      headers: { ...PWA_HEADERS, cookie, ...extra },
      payload: body as Record<string, unknown>,
    });
}

/** An agent-side caller: only the bearer token, as `remotectl` sends it. */
function agentCall(relay: Relay, token: string) {
  return (method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown) =>
    relay.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });
}

interface Account {
  readonly userId: string;
  readonly cookie: string;
  readonly authenticator: SoftwareAuthenticator;
  readonly webauthnUserId: string;
}

/** Registers through `/api/auth` (real passkey), leaving a session without a phone. */
async function register(relay: Relay): Promise<Account> {
  const authenticator = new SoftwareAuthenticator(RP_ID, ORIGIN);
  const inviteCode = (
    await mintInvites({ store, clock: relay.time.clock, random: webCryptoRandom }, 1, 7 * DAY)
  )[0]!;
  const optionsRes = await relay.app.inject({
    method: 'POST',
    url: '/api/auth/register/options',
    headers: PWA_HEADERS,
    payload: { inviteCode },
  });
  const options = optionsRes.json<PublicKeyCredentialCreationOptionsJSON>();
  const res = await relay.app.inject({
    method: 'POST',
    url: '/api/auth/register/verify',
    headers: PWA_HEADERS,
    payload: { ...(await authenticator.create(options)) },
  });
  expect(res.statusCode).toBe(200);
  return {
    userId: res.json<{ userId: string }>().userId,
    cookie: cookieOf(sessionToken(res)),
    authenticator,
    webauthnUserId: options.user.id,
  };
}

/** A second login of the same account: a new session, not yet bound to a phone. */
async function login(relay: Relay, account: Account): Promise<string> {
  const optionsRes = await relay.app.inject({
    method: 'POST',
    url: '/api/auth/login/options',
    headers: PWA_HEADERS,
  });
  const options = optionsRes.json<PublicKeyCredentialRequestOptionsJSON>();
  const res = await relay.app.inject({
    method: 'POST',
    url: '/api/auth/login/verify',
    headers: PWA_HEADERS,
    payload: { ...(await account.authenticator.get(options)) },
  });
  expect(res.statusCode).toBe(200);
  return cookieOf(sessionToken(res));
}

interface Setup extends Account {
  readonly phoneId: string;
  readonly phone: ReturnType<typeof phoneCall>;
  readonly agentId: string;
  readonly agentToken: string;
  readonly agent: ReturnType<typeof agentCall>;
}

/** An account with a bound phone and an enrolled agent. */
async function setup(relay: Relay): Promise<Setup> {
  const account = await register(relay);
  const phone = phoneCall(relay, account.cookie);
  const bound = await phone('/api/devices/phone', { name: 'Pixel' });
  expect(bound.statusCode).toBe(201);
  const enrolled = await phone('/api/agents', { name: 'mac' });
  expect(enrolled.statusCode).toBe(201);
  const { deviceId, enrollToken } = enrolled.json<{ deviceId: string; enrollToken: string }>();
  const agentToken = enrollToken.slice(ENROLL_TOKEN_PREFIX.length);
  return {
    ...account,
    phoneId: bound.json<{ deviceId: string }>().deviceId,
    phone,
    agentId: deviceId,
    agentToken,
    agent: agentCall(relay, agentToken),
  };
}

let codes = 0;
/** A pairing code hash as the phone and agent derive it (32 bytes, base64url). */
async function codeHash(): Promise<string> {
  codes += 1;
  return toBase64Url(await sha256(utf8(`code-${codes}`)));
}

async function openSlot(s: Setup, hash: string): Promise<string> {
  const res = await s.agent('POST', '/api/pairings', { codeHash: hash });
  expect(res.statusCode).toBe(201);
  return res.json<{ slotId: string }>().slotId;
}

async function auditEvents(userId: string): Promise<string[]> {
  const result = await client.query<{ event: string }>(
    'SELECT event FROM audit_log WHERE user_id = $1 ORDER BY id',
    [userId],
  );
  return result.rows.map((row) => row.event);
}

describe('phone binding (sessions.device_id)', () => {
  it('binds a session to a new phone once and re-binds a second session on request', async () => {
    const relay = await startRelay();
    const account = await register(relay);
    const phone = phoneCall(relay, account.cookie);

    expect((await phone('/api/agents', { name: 'mac' })).json()).toEqual({ error: 'no_device' });
    const first = await phone('/api/devices/phone', { name: 'Pixel' });
    expect(first.statusCode).toBe(201);
    expect(first.headers['cache-control']).toBe('no-store');
    const { deviceId } = first.json<{ deviceId: string }>();
    const again = await phone('/api/devices/phone', { name: 'Other' });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ deviceId });

    const second = phoneCall(relay, await login(relay, account));
    const unknown = await second('/api/devices/phone', {
      name: 'Pixel',
      deviceId: '00000000-0000-4000-8000-000000000000',
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'unknown_device' });
    const rebound = await second('/api/devices/phone', { name: 'Pixel', deviceId });
    expect(rebound.statusCode).toBe(200);
    expect(rebound.json()).toEqual({ deviceId });

    expect(await auditEvents(account.userId)).toEqual(['register', 'phone_enrolled', 'login']);
  });

  it('refuses without a session, a bad body, a foreign origin and past the device cap', async () => {
    const relay = await startRelay();
    const unauthenticated = await relay.app.inject({
      method: 'POST',
      url: '/api/devices/phone',
      headers: PWA_HEADERS,
      payload: { name: 'Pixel' },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const account = await register(relay);
    const phone = phoneCall(relay, account.cookie);
    expect((await phone('/api/devices/phone', { name: '' })).statusCode).toBe(400);
    expect((await phone('/api/devices/phone', { name: 'x', extra: 1 })).statusCode).toBe(400);
    expect(
      (await phone('/api/devices/phone', { name: 'Pixel' }, { origin: 'https://evil.test' }))
        .statusCode,
    ).toBe(403);

    expect((await phone('/api/devices/phone', { name: 'Pixel' })).statusCode).toBe(201);
    for (let n = 1; n < DEVICE_CAP; n += 1) {
      expect((await phone('/api/agents', { name: `agent-${n}` })).statusCode).toBe(201);
    }
    const capped = await phone('/api/agents', { name: 'one-too-many' });
    expect(capped.statusCode).toBe(409);
    expect(capped.json()).toEqual({ error: 'device_cap' });
    const another = phoneCall(relay, await login(relay, account));
    expect((await another('/api/devices/phone', { name: 'Tablet' })).json()).toEqual({
      error: 'device_cap',
    });
  });
});

describe('agent enrolment and token rotation (02 §5.5)', () => {
  it('issues a one-time rc-enroll token that authenticates the agent, and rotates it', async () => {
    const relay = await startRelay();
    const s = await setup(relay);
    expect(s.agentToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const [tokenRow] = await client
      .query<{ n: number }>(
        'SELECT count(*)::int AS n FROM agent_tokens WHERE agent_device_id = $1',
        [s.agentId],
      )
      .then((result) => result.rows);
    expect(tokenRow!.n).toBe(1);

    // The token is the agent's WebSocket bearer credential.
    const peer = await WsPeer.open(relay.url, { authorization: `Bearer ${s.agentToken}` });
    expect(await peer.hello('agent')).toMatchObject({ kind: 'hello_ok', deviceId: s.agentId });
    peer.close();

    const rotated = await s.agent('POST', '/api/agents/token');
    expect(rotated.statusCode).toBe(200);
    const { token, userId } = rotated.json<{ token: string; userId: string }>();
    expect(userId).toBe(s.userId);
    expect(token).not.toBe(s.agentToken);
    expect((await s.agent('GET', `/api/pairings/${s.agentId}`)).statusCode).toBe(401);
    const fresh = agentCall(relay, token);
    expect((await fresh('GET', `/api/pairings/${s.agentId}`)).json()).toEqual({
      error: 'unknown_slot',
    });

    expect(await auditEvents(s.userId)).toEqual([
      'register',
      'phone_enrolled',
      'agent_enrolled',
      'agent_token_rotated',
    ]);
    const logs = relay.logs.lines().join('\n');
    expect(logs).not.toContain(s.agentToken);
    expect(logs).not.toContain(token);
  });

  it('refuses malformed and unknown bearer tokens', async () => {
    const relay = await startRelay();
    for (const authorization of ['Bearer nope', 'Basic abc', `Bearer ${'x'.repeat(513)}`]) {
      const res = await relay.app.inject({
        method: 'POST',
        url: '/api/pairings',
        headers: { authorization },
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    }
    const noHeader = await relay.app.inject({ method: 'GET', url: '/api/pairings/x' });
    expect(noHeader.statusCode).toBe(401);
  });

  it('keeps the origin guard for a bearer request that also carries a cookie', async () => {
    const relay = await startRelay();
    const s = await setup(relay);
    const res = await relay.app.inject({
      method: 'POST',
      url: '/api/pairings',
      headers: { authorization: `Bearer ${s.agentToken}`, cookie: s.cookie },
      payload: { codeHash: await codeHash() },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('pairing slots (D6, 02 §5.3)', () => {
  it('expires an unjoined slot at 5 minutes', async () => {
    const relay = await startRelay();
    const s = await setup(relay);
    const hash = await codeHash();
    const opened = await s.agent('POST', '/api/pairings', { codeHash: hash });
    expect(opened.statusCode).toBe(201);
    const { slotId, expiresAt } = opened.json<{ slotId: string; expiresAt: number }>();
    expect(expiresAt).toBe(relay.time.clock.now() + SLOT_TTL_MS);

    relay.time.advance(SLOT_TTL_MS);
    const late = await s.phone('/api/pairings/join', { codeHash: hash });
    expect(late.statusCode).toBe(410);
    expect(late.json()).toEqual({ error: 'expired' });
    expect((await s.agent('GET', `/api/pairings/${slotId}`)).json()).toMatchObject({
      state: 'expired',
      phoneDeviceId: null,
    });
  });

  it('accepts a join just before expiry and refuses a second join', async () => {
    const relay = await startRelay();
    const s = await setup(relay);
    const hash = await codeHash();
    const slotId = await openSlot(s, hash);

    relay.time.advance(SLOT_TTL_MS - 1);
    const joined = await s.phone('/api/pairings/join', { codeHash: hash });
    expect(joined.statusCode).toBe(200);
    expect(joined.json()).toMatchObject({ slotId, agentDeviceId: s.agentId });

    const second = await s.phone('/api/pairings/join', { codeHash: hash });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'already_joined' });
    const otherPhone = phoneCall(relay, await login(relay, s));
    await otherPhone('/api/devices/phone', { name: 'Tablet' });
    expect((await otherPhone('/api/pairings/join', { codeHash: hash })).json()).toEqual({
      error: 'already_joined',
    });

    expect((await s.agent('GET', `/api/pairings/${slotId}`)).json()).toEqual({
      slotId,
      state: 'joined',
      phoneDeviceId: s.phoneId,
      failedAttempts: 0,
      expiresAt: relay.time.clock.now() + 1,
    });
  });

  it('refuses an unknown code, a foreign account and a code another agent holds', async () => {
    const relay = await startRelay();
    const s = await setup(relay);
    const hash = await codeHash();
    await openSlot(s, hash);

    expect((await s.phone('/api/pairings/join', { codeHash: await codeHash() })).json()).toEqual({
      error: 'unknown_slot',
    });
    expect((await s.phone('/api/pairings/join', { codeHash: 'short' })).statusCode).toBe(400);

    const stranger = await setup(relay);
    expect((await stranger.phone('/api/pairings/join', { codeHash: hash })).statusCode).toBe(404);
    const taken = await stranger.agent('POST', '/api/pairings', { codeHash: hash });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toEqual({ error: 'code_in_use' });
    expect((await stranger.agent('POST', '/api/pairings', {})).statusCode).toBe(400);
  });

  it('records the pairing on complete and removes the slot', async () => {
    const relay = await startRelay();
    const s = await setup(relay);
    const hash = await codeHash();
    const slotId = await openSlot(s, hash);

    const early = await s.agent('POST', `/api/pairings/${slotId}/complete`);
    expect(early.statusCode).toBe(409);
    expect(early.json()).toEqual({ error: 'not_joined' });

    await s.phone('/api/pairings/join', { codeHash: hash });
    const done = await s.agent('POST', `/api/pairings/${slotId}/complete`);
    expect(done.statusCode).toBe(200);
    const { pairingId, phoneDeviceId } = done.json<{ pairingId: string; phoneDeviceId: string }>();
    expect(phoneDeviceId).toBe(s.phoneId);

    const rows = await db.orm.select().from(pairings).where(eq(pairings.id, pairingId));
    expect(rows).toMatchObject([
      { userId: s.userId, phoneDeviceId: s.phoneId, agentDeviceId: s.agentId, revokedAt: null },
    ]);
    expect(await db.orm.select().from(pairingSlots).where(eq(pairingSlots.id, slotId))).toEqual([]);
    expect((await s.agent('GET', `/api/pairings/${slotId}`)).statusCode).toBe(404);
    expect(await auditEvents(s.userId)).toContain('pairing_completed');

    // Pairing the same two devices again reuses the row.
    const again = await openSlot(s, await codeHash());
    const slot = await db.orm.select().from(pairingSlots).where(eq(pairingSlots.id, again));
    await s.phone('/api/pairings/join', { codeHash: toBase64Url(slot[0]!.codeHash) });
    expect((await s.agent('POST', `/api/pairings/${again}/complete`)).json()).toEqual({
      pairingId,
      phoneDeviceId: s.phoneId,
    });

    const logs = relay.logs.lines().join('\n');
    expect(logs).not.toContain(hash);
  });

  it('reopens the slot after a failed handshake and closes it after three', async () => {
    const relay = await startRelay();
    const s = await setup(relay);
    const hash = await codeHash();
    const slotId = await openSlot(s, hash);

    expect((await s.agent('POST', `/api/pairings/${slotId}/fail`)).statusCode).toBe(409);
    for (const attempt of [1, 2, 3]) {
      expect((await s.phone('/api/pairings/join', { codeHash: hash })).statusCode).toBe(200);
      expect((await s.agent('POST', `/api/pairings/${slotId}/fail`)).json()).toEqual({
        state: attempt < 3 ? 'open' : 'closed',
        failedAttempts: attempt,
      });
    }
    const closed = await s.phone('/api/pairings/join', { codeHash: hash });
    expect(closed.statusCode).toBe(410);
    expect(closed.json()).toEqual({ error: 'closed' });
    expect((await s.agent('GET', `/api/pairings/${slotId}`)).json()).toMatchObject({
      state: 'closed',
    });
    expect((await s.agent('POST', `/api/pairings/${slotId}/complete`)).json()).toEqual({
      error: 'closed',
    });
  });

  it('expires a joined slot after the handshake grace', async () => {
    const relay = await startRelay();
    const s = await setup(relay);
    const hash = await codeHash();
    const slotId = await openSlot(s, hash);
    await s.phone('/api/pairings/join', { codeHash: hash });

    relay.time.advance(HANDSHAKE_GRACE_MS);
    const late = await s.agent('POST', `/api/pairings/${slotId}/complete`);
    expect(late.statusCode).toBe(410);
    expect(late.json()).toEqual({ error: 'expired' });
  });

  it('cancels a slot, replaces it on reopen, and scopes slots to their agent', async () => {
    const relay = await startRelay();
    const s = await setup(relay);
    const first = await openSlot(s, await codeHash());
    const second = await openSlot(s, await codeHash());
    expect((await s.agent('GET', `/api/pairings/${first}`)).statusCode).toBe(404);

    const stranger = await setup(relay);
    expect((await stranger.agent('DELETE', `/api/pairings/${second}`)).statusCode).toBe(404);
    expect((await stranger.agent('POST', `/api/pairings/${second}/fail`)).statusCode).toBe(404);
    expect((await s.agent('GET', '/api/pairings/not-a-uuid')).statusCode).toBe(400);

    expect((await s.agent('DELETE', `/api/pairings/${second}`)).statusCode).toBe(204);
    expect((await s.agent('GET', `/api/pairings/${second}`)).statusCode).toBe(404);
  });

  it('rate-limits joins per account', async () => {
    const relay = await startRelay({ joinSlot: { max: 1, windowMs: 60_000 } });
    const s = await setup(relay);
    await s.phone('/api/pairings/join', { codeHash: await codeHash() });
    const limited = await s.phone('/api/pairings/join', { codeHash: await codeHash() });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
  });

  it('rate-limits slot calls per agent', async () => {
    const relay = await startRelay({ slot: { max: 1, windowMs: 60_000 } });
    const s = await setup(relay);
    await s.agent('GET', `/api/pairings/${s.agentId}`);
    expect((await s.agent('GET', `/api/pairings/${s.agentId}`)).statusCode).toBe(429);
  });
});

/** A UUIDv7-shaped envelope id. */
const envelopeId = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

function command(from: string, to: string, n: number, decisionHash?: string) {
  return {
    v: 1,
    kind: 'data',
    id: envelopeId(n),
    from,
    to,
    session: null,
    cls: 'command',
    seq: n,
    ts: 0,
    expiresAt: null,
    payload: 'AAAA',
    ...(decisionHash === undefined ? {} : { decisionHash }),
  };
}

/** Both devices of `s` connected over WebSocket and past `hello`. */
async function connect(relay: Relay, s: Setup) {
  const agentPeer = await WsPeer.open(relay.url, { authorization: `Bearer ${s.agentToken}` });
  await agentPeer.hello('agent');
  const phonePeer = await WsPeer.open(relay.url, { origin: ORIGIN, cookie: s.cookie });
  await phonePeer.hello('phone');
  await agentPeer.next('presence');
  return { agentPeer, phonePeer };
}

let hashes = 0;
async function decisionHashHex(): Promise<string> {
  hashes += 1;
  return toHex(await sha256(utf8(`decision-${hashes}`)));
}

describe('decision verification (D7, 02 §5.4)', () => {
  it('drops an unverified decision command with error: unverified, forwards it once verified', async () => {
    const relay = await startRelay();
    const s = await setup(relay);
    const { agentPeer, phonePeer } = await connect(relay, s);
    const hash = await decisionHashHex();

    phonePeer.send(command(s.phoneId, s.agentId, 1, hash));
    expect(await phonePeer.next('error')).toMatchObject({ code: 'unverified', ref: envelopeId(1) });

    const challenge = await s.phone('/api/decisions/challenge', { decisionHash: hash });
    expect(challenge.statusCode).toBe(200);
    const options = challenge.json<PublicKeyCredentialRequestOptionsJSON>();
    expect(options.challenge).toBe(toBase64Url(Buffer.from(hash, 'hex')));
    expect(options.userVerification).toBe('required');
    const verified = await s.phone('/api/decisions/verify', {
      response: await s.authenticator.get(options),
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toEqual({
      decisionHash: hash,
      verifiedUntil: relay.time.clock.now() + VERIFIED_TTL_MS,
    });

    phonePeer.send(command(s.phoneId, s.agentId, 2, hash));
    expect(await agentPeer.next('data')).toMatchObject({ id: envelopeId(2), decisionHash: hash });
    // Commands without a decision hash (deny, stop) need no assertion.
    phonePeer.send(command(s.phoneId, s.agentId, 3));
    expect(await agentPeer.next('data')).toMatchObject({ id: envelopeId(3) });
    // The unverified one never reached the agent.
    expect(agentPeer.frames.filter((frame) => frame.kind === 'data')).toEqual([]);

    const [passkey] = await db.orm
      .select({ counter: passkeys.counter })
      .from(passkeys)
      .where(eq(passkeys.userId, s.userId));
    expect(passkey!.counter).toBe(1);

    const logs = relay.logs.lines().join('\n');
    expect(logs).toContain('"event":"command_refused"');
    expect(logs).not.toContain(hash);
    agentPeer.close();
    phonePeer.close();
  });

  it('refuses a replayed assertion and a new challenge for a used hash', async () => {
    const relay = await startRelay();
    const s = await setup(relay);
    const hash = await decisionHashHex();
    const options = (
      await s.phone('/api/decisions/challenge', { decisionHash: hash })
    ).json<PublicKeyCredentialRequestOptionsJSON>();
    const assertion = await s.authenticator.get(options);
    expect((await s.phone('/api/decisions/verify', { response: assertion })).statusCode).toBe(200);

    const replay = await s.phone('/api/decisions/verify', { response: assertion });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toEqual({ error: 'replayed' });
    const rechallenge = await s.phone('/api/decisions/challenge', { decisionHash: hash });
    expect(rechallenge.statusCode).toBe(409);
    expect(rechallenge.json()).toEqual({ error: 'replayed' });
  });

  it('only admits the command from the phone that verified it', async () => {
    const relay = await startRelay();
    const s = await setup(relay);
    const { agentPeer } = await connect(relay, s);
    const hash = await decisionHashHex();
    const options = (
      await s.phone('/api/decisions/challenge', { decisionHash: hash })
    ).json<PublicKeyCredentialRequestOptionsJSON>();
    await s.phone('/api/decisions/verify', { response: await s.authenticator.get(options) });

    const tabletCookie = await login(relay, s);
    const tablet = phoneCall(relay, tabletCookie);
    const tabletId = (await tablet('/api/devices/phone', { name: 'Tablet' })).json<{
      deviceId: string;
    }>().deviceId;
    const tabletPeer = await WsPeer.open(relay.url, { origin: ORIGIN, cookie: tabletCookie });
    await tabletPeer.hello('phone');
    tabletPeer.send(command(tabletId, s.agentId, 1, hash));
    expect(await tabletPeer.next('error')).toMatchObject({ code: 'unverified' });
    agentPeer.close();
    tabletPeer.close();
  });

  it('refuses assertions that fail verification', async () => {
    const relay = await startRelay();
    const s = await setup(relay);
    const challengeFor = async (hash: string) =>
      (
        await s.phone('/api/decisions/challenge', { decisionHash: hash })
      ).json<PublicKeyCredentialRequestOptionsJSON>();
    const verify = (response: unknown) => s.phone('/api/decisions/verify', { response });

    // No UV.
    const noUv = await verify(
      await s.authenticator.get(await challengeFor(await decisionHashHex()), {
        userVerified: false,
      }),
    );
    expect(noUv.statusCode).toBe(401);
    expect(noUv.json()).toEqual({ error: 'verification_failed' });

    // A user handle that is not the account's.
    const wrongHandle = await verify(
      await s.authenticator.get(await challengeFor(await decisionHashHex()), {
        userHandle: 'bm9ib2R5',
      }),
    );
    expect(wrongHandle.json()).toEqual({ error: 'verification_failed' });

    // A challenge this phone never asked for.
    const unasked = await verify(
      await s.authenticator.get(await challengeFor(await decisionHashHex()), {
        challenge: toBase64Url(Buffer.from(await decisionHashHex(), 'hex')),
      }),
    );
    expect(unasked.statusCode).toBe(400);
    expect(unasked.json()).toEqual({ error: 'unknown_challenge' });

    // Unreadable client data.
    const assertion = await s.authenticator.get(await challengeFor(await decisionHashHex()));
    const garbled = await verify({
      ...assertion,
      response: { ...assertion.response, clientDataJSON: 'AAAA' },
    });
    expect(garbled.json()).toEqual({ error: 'unknown_challenge' });

    // Another account's passkey.
    const stranger = await setup(relay);
    const foreign = await verify(
      await stranger.authenticator.get(await challengeFor(await decisionHashHex())),
    );
    expect(foreign.statusCode).toBe(401);
    expect(foreign.json()).toEqual({ error: 'unknown_credential' });

    // Malformed bodies.
    expect((await verify({ id: 'x' })).statusCode).toBe(400);
    expect((await s.phone('/api/decisions/challenge', { decisionHash: 'ABC' })).json()).toEqual({
      error: 'bad_request',
    });
  });

  it('requires a phone-bound session', async () => {
    const relay = await startRelay();
    const account = await register(relay);
    const res = await phoneCall(relay, account.cookie)('/api/decisions/challenge', {
      decisionHash: await decisionHashHex(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'no_device' });
  });
});

describe('device revocation', () => {
  it('stops a revoked phone from joining (directory lookup)', async () => {
    const relay = await startRelay();
    const s = await setup(relay);
    const hash = await codeHash();
    await openSlot(s, hash);
    await db.orm
      .update(devices)
      .set({ revokedAt: new Date(relay.time.clock.now()) })
      .where(eq(devices.id, s.phoneId));
    expect((await s.phone('/api/pairings/join', { codeHash: hash })).statusCode).toBe(409);
    const [session] = await db.orm
      .select({ deviceId: sessions.deviceId })
      .from(sessions)
      .where(eq(sessions.userId, s.userId));
    expect(session!.deviceId).toBe(s.phoneId);
  });
});
