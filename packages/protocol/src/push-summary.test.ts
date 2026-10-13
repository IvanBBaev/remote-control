import { describe, expect, it } from 'vitest';

import {
  decodePushSummary,
  encodePushSummary,
  MAX_PUSH_SUMMARY_JSON_BYTES,
  PushSummary,
} from './push-summary.js';

const REQUEST = '0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const bytes = (text: string) => new TextEncoder().encode(text).length;

describe('PushSummary (D5)', () => {
  it('round-trips a full summary unchanged', () => {
    const summary: PushSummary = {
      v: 1,
      p: 'remote-control',
      l: 'Run a command',
      s: 'pnpm test',
      r: REQUEST,
    };
    const text = encodePushSummary(summary);
    expect(JSON.parse(text)).toEqual(summary);
    expect(decodePushSummary(text)).toEqual(summary);
  });

  it('accepts the label alone', () => {
    expect(decodePushSummary(encodePushSummary({ v: 1, l: 'Read a file' }))).toEqual({
      v: 1,
      l: 'Read a file',
    });
  });

  it('shrinks the line first, then the project, to fit 996 bytes', () => {
    const wide = '𝄞';
    const text = encodePushSummary({
      v: 1,
      p: wide.repeat(128),
      l: wide.repeat(200),
      s: wide.repeat(240),
      r: REQUEST,
    });
    expect(bytes(text)).toBeLessThanOrEqual(MAX_PUSH_SUMMARY_JSON_BYTES);
    const decoded = decodePushSummary(text)!;
    expect(decoded.s).toBeUndefined();
    expect(decoded.p).toMatch(/…$/);
    expect(decoded.l).toBe(wide.repeat(200));
    expect(decoded.r).toBe(REQUEST);
  });

  it('keeps a shortened line when it fits', () => {
    const text = encodePushSummary({ v: 1, p: 'x'.repeat(128), l: 'Run', s: '𝄞'.repeat(240) });
    const decoded = decodePushSummary(text)!;
    expect(bytes(text)).toBeLessThanOrEqual(MAX_PUSH_SUMMARY_JSON_BYTES);
    expect(decoded.s).toMatch(/^(?:𝄞)+…$/u);
    expect(decoded.p).toBe('x'.repeat(128));
  });

  it('refuses an invalid summary to encode', () => {
    expect(() => encodePushSummary({ v: 1, l: '' })).toThrow();
  });

  it('decodes anything else to undefined', () => {
    expect(decodePushSummary('not json')).toBeUndefined();
    expect(decodePushSummary('{"v":2,"l":"x"}')).toBeUndefined();
    expect(decodePushSummary('{"v":1,"l":"x","body":"leak"}')).toBeUndefined();
  });
});
