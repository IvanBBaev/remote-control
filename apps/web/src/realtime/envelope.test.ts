import { describe, expect, it } from 'vitest';

import { fromBase64, header, toBase64, uuidV7 } from './envelope.js';

describe('envelope helpers', () => {
  it('builds a UUIDv7 from the clock and the random port', () => {
    const id = uuidV7(Date.UTC(2026, 9, 1), { bytes: (n) => new Uint8Array(n).fill(0xff) });
    expect(id).toBe('01a0f4c2-c400-7fff-bfff-ffffffffffff');
  });

  it('round-trips base64 and strips the payload for the AAD', () => {
    const bytes = new Uint8Array([0, 1, 254, 255, 128]);
    expect(toBase64(bytes)).toBe('AAH+/4A=');
    expect(fromBase64('AAH+/4A=')).toEqual(bytes);
    const envelope = {
      v: 1,
      kind: 'data',
      id: 'x',
      from: 'a',
      to: 'b',
      session: null,
      cls: 'event',
      seq: 0,
      ts: 0,
      expiresAt: null,
      payload: 'AA==',
    } as const;
    expect(header(envelope)).not.toHaveProperty('payload');
    expect(header(envelope).id).toBe('x');
  });
});
