import { describe, expect, it } from 'vitest';

import {
  MAX_PAUSE_MS,
  isPaused,
  parseDuration,
  parsePause,
  pauseAt,
  pauseStatusText,
} from './pause-state.js';

const NOW = 1_760_000_000_000;

describe('pause state (M1-03)', () => {
  it.each([
    ['30m', 30 * 60_000],
    ['2h', 2 * 3_600_000],
    ['1d', 86_400_000],
    [' 45m ', 45 * 60_000],
    ['30d', MAX_PAUSE_MS],
  ])('parses the duration %j', (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });

  it.each(['', '2', 'h', '0h', '-1h', '1.5h', '2H', '1h30m', '2 h', '10s', '31d', '721h', 'abc'])(
    'rejects the duration %j',
    (text) => {
      expect(parseDuration(text)).toBeUndefined();
    },
  );

  it('pauses until resumed or until the expiry', () => {
    expect(pauseAt(NOW)).toEqual({ version: 1, pausedAt: NOW, until: null });
    expect(pauseAt(NOW, 60_000)).toEqual({ version: 1, pausedAt: NOW, until: NOW + 60_000 });
    expect(isPaused(undefined, NOW)).toBe(false);
    expect(isPaused(pauseAt(NOW), NOW + MAX_PAUSE_MS * 10)).toBe(true);
    expect(isPaused(pauseAt(NOW, 60_000), NOW + 59_999)).toBe(true);
    expect(isPaused(pauseAt(NOW, 60_000), NOW + 60_000)).toBe(false);
  });

  it('describes the pause for `remotectl status`', () => {
    expect(pauseStatusText(undefined, NOW)).toBe('not paused');
    expect(pauseStatusText(pauseAt(NOW), NOW)).toBe('paused');
    expect(pauseStatusText(pauseAt(NOW, 7_200_000), NOW)).toBe(
      `paused until ${new Date(NOW + 7_200_000).toISOString()}`,
    );
    expect(pauseStatusText(pauseAt(NOW, 1), NOW + 1)).toBe('not paused');
  });

  it('reads a corrupt or foreign file as not paused', () => {
    expect(parsePause(JSON.stringify(pauseAt(NOW, 5)))).toEqual(pauseAt(NOW, 5));
    expect(parsePause('not json')).toBeUndefined();
    expect(parsePause('{"version":2,"pausedAt":1,"until":null}')).toBeUndefined();
    expect(parsePause('{"version":1,"pausedAt":1,"until":null,"extra":true}')).toBeUndefined();
    expect(parsePause('{"version":1,"pausedAt":-1,"until":null}')).toBeUndefined();
  });
});
