import { describe, expect, it } from 'vitest';

import {
  UPDATE_CHECK_INTERVAL_MS,
  cacheIsFresh,
  compareVersions,
  isNewer,
  parseUpdateCache,
  serializeUpdateCache,
  verdict,
} from './update-check.js';

describe('compareVersions', () => {
  it.each([
    ['1.0.0', '1.0.0', 0],
    ['1.0.1', '1.0.0', 1],
    ['1.1.0', '1.0.9', 1],
    ['2.0.0', '10.0.0', -1],
    ['1.0.0-alpha', '1.0.0', -1],
    ['1.0.0', '1.0.0-rc.1', 1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0-alpha.1', '1.0.0-alpha.beta', -1],
    ['1.0.0-alpha.beta', '1.0.0-beta', -1],
    ['1.0.0-beta.2', '1.0.0-beta.11', -1],
    ['1.0.0-rc.1', '1.0.0-beta.11', 1],
    ['1.0.0+build.5', '1.0.0+build.7', 0],
  ])('%s vs %s is %d', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
    expect(compareVersions(b, a)).toBe(-expected || 0);
  });

  it.each(['', 'latest', '1.0', 'v1.0.0', '01.0.0', '1.0.0-01', '1.0.0-', '99999999999999999.0.0'])(
    'gives no answer for the unparsable %j',
    (bad) => {
      expect(compareVersions(bad, '1.0.0')).toBeUndefined();
      expect(compareVersions('1.0.0', bad)).toBeUndefined();
    },
  );
});

describe('isNewer', () => {
  it('is true only for a strictly newer, parsable version', () => {
    expect(isNewer('0.2.0', '0.1.0')).toBe(true);
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
    expect(isNewer('0.1.0-rc.1', '0.1.0')).toBe(false);
    expect(isNewer('garbage', '0.1.0')).toBe(false);
  });
});

describe('verdict', () => {
  it('says available or current', () => {
    expect(verdict('0.1.0', '0.2.0', 'registry')).toEqual({
      status: 'available',
      current: '0.1.0',
      latest: '0.2.0',
      source: 'registry',
    });
    expect(verdict('0.1.0', '0.1.0', 'cache').status).toBe('current');
  });
});

describe('cacheIsFresh', () => {
  const now = 1_760_000_000_000;

  it('is fresh for less than 24 h only', () => {
    expect(cacheIsFresh(undefined, now)).toBe(false);
    expect(cacheIsFresh({ checkedAt: now, latest: '1.0.0' }, now)).toBe(true);
    expect(
      cacheIsFresh({ checkedAt: now - UPDATE_CHECK_INTERVAL_MS + 1, latest: '1.0.0' }, now),
    ).toBe(true);
    expect(cacheIsFresh({ checkedAt: now - UPDATE_CHECK_INTERVAL_MS, latest: '1.0.0' }, now)).toBe(
      false,
    );
    expect(cacheIsFresh({ checkedAt: now + 1, latest: '1.0.0' }, now)).toBe(false);
  });
});

describe('parseUpdateCache', () => {
  it('round-trips through serializeUpdateCache', () => {
    const cache = { checkedAt: 5, latest: '1.2.3', etag: 'W/"abc"' };
    expect(parseUpdateCache(serializeUpdateCache(cache))).toEqual(cache);
    expect(parseUpdateCache(serializeUpdateCache({ checkedAt: 5, latest: '1.2.3' }))).toEqual({
      checkedAt: 5,
      latest: '1.2.3',
    });
  });

  it.each([
    undefined,
    '',
    '{',
    'null',
    '[]',
    '{"latest":"1.0.0"}',
    '{"checkedAt":"5","latest":"1.0.0"}',
    '{"checkedAt":5}',
    '{"checkedAt":5,"latest":""}',
    '{"checkedAt":5,"latest":"1.0.0","etag":7}',
  ])('treats %j as absent', (text) => {
    expect(parseUpdateCache(text)).toBeUndefined();
  });
});
