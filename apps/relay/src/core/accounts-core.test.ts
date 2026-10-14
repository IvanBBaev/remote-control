import { sha256, utf8 } from '@remote-control/crypto';
import type { Random } from '@remote-control/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { AccountStore } from '../ports/account-store.js';
import { crockfordBase32 } from './crockford-base32.js';
import { MemoryChallengeLedger } from './memory-challenge-ledger.js';
import { MAX_INVITES_PER_RUN, mintInvites } from './invites.js';
import { checkOrigin } from './origin-guard.js';
import { FixedWindowRateLimiter } from './rate-limiter.js';
import {
  inviteCodeHash,
  newInviteCode,
  newRecoveryCode,
  parseRecoveryCode,
} from './secret-codes.js';
import { sessionCookie } from './session-cookie.js';

function fakeClock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

/** Deterministic bytes: 0, 1, 2, … continuing across calls. */
function countingRandom(): Random {
  let next = 0;
  return { bytes: (n) => Uint8Array.from({ length: n }, () => next++ & 0xff) };
}

describe('crockfordBase32', () => {
  it('encodes without padding and in upper case', () => {
    expect(crockfordBase32.encode(new Uint8Array())).toBe('');
    expect(crockfordBase32.encode(Uint8Array.from([0xff]))).toBe('ZW');
    expect(crockfordBase32.encode(Uint8Array.from([0, 0, 0, 0, 0]))).toBe('00000000');
    expect(crockfordBase32.encode(new Uint8Array(16))).toHaveLength(26);
  });

  it('normalizes case, dashes, spaces and look-alikes, rejecting other characters', () => {
    expect(crockfordBase32.normalize('ab-cd ef')).toBe('ABCDEF');
    expect(crockfordBase32.normalize('oOiIlL')).toBe('001111');
    expect(crockfordBase32.normalize('U')).toBeNull();
    expect(crockfordBase32.normalize('a+b')).toBeNull();
  });
});

describe('secret codes', () => {
  it('mints 128-bit invite codes and hashes their canonical form', async () => {
    const code = newInviteCode(countingRandom());
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const expected = await sha256(utf8(code));
    expect(await inviteCodeHash(code.toLowerCase())).toEqual(expected);
    expect(await inviteCodeHash(`${code.slice(0, 13)}-${code.slice(13)}`)).toEqual(expected);
    expect(await inviteCodeHash(code.slice(1))).toBeNull();
    expect(await inviteCodeHash('!'.repeat(26))).toBeNull();
  });

  it('mints recovery codes as LOCATOR-SECRET and parses typed variants', () => {
    const code = newRecoveryCode(countingRandom());
    expect(code.locator).toHaveLength(8);
    expect(code.secret).toHaveLength(26);
    expect(code.display).toBe(`${code.locator}-${code.secret}`);
    expect(parseRecoveryCode(code.display.toLowerCase())).toEqual({
      locator: code.locator,
      secret: code.secret,
    });
    expect(parseRecoveryCode(code.locator + code.secret)).not.toBeNull();
    expect(parseRecoveryCode(code.display.slice(1))).toBeNull();
    expect(parseRecoveryCode('#'.repeat(35))).toBeNull();
  });
});

describe('MemoryChallengeLedger challenges', () => {
  const login = { kind: 'login' } as const;

  it('hands a challenge out once and only before it expires', async () => {
    const ledger = new MemoryChallengeLedger();
    await ledger.put('a', login, 100, 0);
    await ledger.put('b', { kind: 'recovery', userId: 'u', recoveryCodeId: 'r' }, 100, 0);
    expect(await ledger.take('a', 0)).toEqual(login);
    expect(await ledger.take('a', 0)).toBeUndefined();
    expect(await ledger.take('unknown', 0)).toBeUndefined();
    expect(await ledger.take('b', 100)).toBeUndefined();
    expect(ledger.size).toBe(0);
  });

  it('evicts expired entries first, then the oldest live one, when full', async () => {
    const ledger = new MemoryChallengeLedger(2);
    await ledger.put('old', login, 100, 0);
    await ledger.put('mid', login, 150, 50);
    await ledger.put('new', login, 210, 110); // `old` expired and is dropped
    expect(ledger.size).toBe(2);
    expect(await ledger.take('mid', 110)).toEqual(login);
    await ledger.put('newer', login, 210, 110);
    await ledger.put('newest', login, 210, 110); // full of live entries: `new` (oldest) goes
    expect(ledger.size).toBe(2);
    expect(await ledger.take('new', 110)).toBeUndefined();
    expect(await ledger.take('newer', 110)).toEqual(login);
    expect(await ledger.take('newest', 110)).toEqual(login);
  });

  it('copes with a zero capacity', async () => {
    const ledger = new MemoryChallengeLedger(0);
    await ledger.put('a', login, 100, 0);
    expect(await ledger.take('a', 0)).toEqual(login);
  });
});

describe('FixedWindowRateLimiter', () => {
  it('allows max hits per window per key and reports the time to reset', () => {
    const clock = fakeClock();
    const limiter = new FixedWindowRateLimiter(clock);
    const limit = { max: 2, windowMs: 1_000 };
    expect(limiter.hit('k', limit)).toEqual({ allowed: true });
    clock.advance(400);
    expect(limiter.hit('k', limit)).toEqual({ allowed: true });
    expect(limiter.hit('k', limit)).toEqual({ allowed: false, retryAfterMs: 600 });
    expect(limiter.hit('other', limit)).toEqual({ allowed: true });
    clock.advance(600);
    expect(limiter.hit('k', limit)).toEqual({ allowed: true });
  });

  it('drops ended windows once more than 10 000 keys are tracked', () => {
    const clock = fakeClock();
    const limiter = new FixedWindowRateLimiter(clock);
    const limit = { max: 1, windowMs: 1_000 };
    for (let i = 0; i <= 10_000; i += 1) limiter.hit(`ip:${i}`, limit);
    limiter.hit('live', { max: 1, windowMs: 10_000 });
    expect(limiter.size).toBe(10_002);
    clock.advance(1_000);
    limiter.hit('fresh', limit);
    expect(limiter.size).toBe(2);
  });
});

describe('mintInvites', () => {
  function recordingStore() {
    const createInvites = vi.fn<AccountStore['createInvites']>(() => Promise.resolve());
    return { store: { createInvites } as unknown as AccountStore, createInvites };
  }

  it('stores only the hashes of the codes it returns', async () => {
    const { store, createInvites } = recordingStore();
    const clock = fakeClock(5_000);
    const codes = await mintInvites({ store, clock, random: countingRandom() }, 3, 1_000);
    expect(codes).toHaveLength(3);
    expect(new Set(codes).size).toBe(3);
    const [hashes, expiresAt, now] = createInvites.mock.calls[0]!;
    expect(hashes).toEqual(await Promise.all(codes.map((code) => sha256(utf8(code)))));
    expect(expiresAt).toBe(6_000);
    expect(now).toBe(5_000);
  });

  it('rejects a count or ttl out of range', async () => {
    const { store, createInvites } = recordingStore();
    const deps = { store, clock: fakeClock(), random: countingRandom() };
    for (const count of [0, MAX_INVITES_PER_RUN + 1, 1.5]) {
      await expect(mintInvites(deps, count, 1_000)).rejects.toBeInstanceOf(RangeError);
    }
    for (const ttl of [0, -1, Number.POSITIVE_INFINITY]) {
      await expect(mintInvites(deps, 1, ttl)).rejects.toBeInstanceOf(RangeError);
    }
    expect(createInvites).not.toHaveBeenCalled();
  });
});

describe('sessionCookie', () => {
  it('serializes the __Host- cookie with Secure, HttpOnly, SameSite=Strict and Path=/', () => {
    expect(sessionCookie.name).toBe('__Host-rc_session');
    expect(sessionCookie.serialize('tok', 60)).toBe(
      '__Host-rc_session=tok; Max-Age=60; Path=/; Secure; HttpOnly; SameSite=Strict',
    );
    expect(sessionCookie.clear()).toBe(
      '__Host-rc_session=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict',
    );
  });

  it('reads the session token among other cookies', () => {
    expect(sessionCookie.read(undefined)).toBeUndefined();
    expect(sessionCookie.read('a=1; __Host-rc_session=tok ; b=2')).toBe('tok');
    expect(sessionCookie.read('__Host-rc_session=')).toBeUndefined();
    expect(sessionCookie.read('rc_session=tok; =x; junk')).toBeUndefined();
  });
});

describe('checkOrigin', () => {
  const origin = 'https://rc.example.test';
  it('accepts a same-origin PWA request, with or without Sec-Fetch-Site', () => {
    expect(checkOrigin({ origin, secFetchSite: 'same-origin', client: 'pwa' }, origin)).toBeNull();
    expect(checkOrigin({ origin, client: 'pwa' }, origin)).toBeNull();
  });

  it('names the failed check', () => {
    expect(checkOrigin({ client: 'pwa' }, origin)).toBe('origin_missing');
    expect(checkOrigin({ origin: 'null', client: 'pwa' }, origin)).toBe('origin_mismatch');
    expect(checkOrigin({ origin, secFetchSite: 'none', client: 'pwa' }, origin)).toBe('cross_site');
    expect(checkOrigin({ origin }, origin)).toBe('client_header');
  });
});
