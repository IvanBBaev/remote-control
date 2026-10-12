import { describe, expect, it } from 'vitest';

import { toBase64Url, toHex } from './encoding.js';

describe('toHex', () => {
  it('pads every byte to two lower-case digits', () => {
    expect(toHex(new Uint8Array([0, 1, 15, 16, 171, 255]))).toBe('00010f10abff');
    expect(toHex(new Uint8Array())).toBe('');
  });
});

describe('toBase64Url', () => {
  it.each([
    [[], ''],
    [[0xff], '_w'],
    [[0xfb, 0xff], '-_8'],
    [[0x66, 0x6f, 0x6f], 'Zm9v'],
  ])('encodes %j as %s without padding', (bytes, expected) => {
    expect(toBase64Url(new Uint8Array(bytes))).toBe(expected);
  });
});
