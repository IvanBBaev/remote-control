import { describe, expect, it } from 'vitest';

import { encodeFrame } from './encode-frame.js';
import { parseFrame } from './parse-frame.js';

describe('encodeFrame', () => {
  it('writes sorted keys without whitespace', () => {
    expect(encodeFrame({ v: 1, kind: 'pong', t: 5, relayTs: 9 })).toBe(
      '{"kind":"pong","relayTs":9,"t":5,"v":1}',
    );
  });

  it('is the inverse of parseFrame', () => {
    const text = encodeFrame({ v: 1, kind: 'ping', t: 42 });
    const parsed = parseFrame(text);
    expect(parsed).toEqual({ ok: true, frame: { v: 1, kind: 'ping', t: 42 } });
    if (parsed.ok) expect(encodeFrame(parsed.frame)).toBe(text);
  });
});
