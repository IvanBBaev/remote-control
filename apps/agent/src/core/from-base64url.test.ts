import { toBase64Url } from '@remote-control/protocol';
import { describe, expect, it } from 'vitest';

import { fromBase64Url } from './from-base64url.js';

describe('fromBase64Url', () => {
  it('inverts toBase64Url for every length', () => {
    for (let length = 0; length < 40; length += 1) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 251) % 256);
      expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    }
  });

  it('refuses padding, the standard alphabet, impossible lengths and spare bits', () => {
    expect(fromBase64Url('AA==')).toBeUndefined();
    expect(fromBase64Url('+/8')).toBeUndefined();
    expect(fromBase64Url('A')).toBeUndefined();
    expect(fromBase64Url('AB')).toBeUndefined();
    expect(fromBase64Url('AA')).toEqual(new Uint8Array([0]));
  });
});
