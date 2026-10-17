import { describe, expect, it } from 'vitest';

import { formatAgo, formatCountdown } from './time';

const NOW = 1_800_000_000_000;

describe('formatAgo', () => {
  it.each([
    [NOW + 5_000, 'now'],
    [NOW - 59_999, 'now'],
    [NOW - 4 * 60_000, '4m'],
    [NOW - 2 * 3_600_000, '2h'],
    [NOW - 3 * 86_400_000, '3d'],
  ])('%i → %s', (at, expected) => {
    expect(formatAgo(at, NOW)).toBe(expected);
  });
});

describe('formatCountdown', () => {
  it.each([
    [NOW + 245_000, '4:05'],
    [NOW + 400, '0:01'],
    [NOW, 'expired'],
    [NOW - 1, 'expired'],
  ])('%i → %s', (deadline, expected) => {
    expect(formatCountdown(deadline, NOW)).toBe(expected);
  });
});
