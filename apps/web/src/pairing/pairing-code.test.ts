import { hkdfSha256, utf8 } from '@remote-control/crypto';
import { toBase64Url } from '@remote-control/protocol';
import { describe, expect, it } from 'vitest';

import {
  formatPairingCode,
  normalizePairingCode,
  pairingCodeCharacters,
  pairingSecrets,
} from './pairing-code.js';

describe('pairing code', () => {
  it('reads look-alikes the Crockford way and drops everything else', () => {
    expect(pairingCodeCharacters(' oiL0-12u34 ')).toBe('01101234');
    expect(pairingCodeCharacters('ABCDEFGHJKMNPQRS')).toBe('ABCDEFGHJKMN');
  });

  it('groups the input by four while typing', () => {
    expect(formatPairingCode('')).toBe('');
    expect(formatPairingCode('abc')).toBe('ABC');
    expect(formatPairingCode('abcd')).toBe('ABCD');
    expect(formatPairingCode('abcde')).toBe('ABCD-E');
    expect(formatPairingCode('ABCD-EFGH-JKMN')).toBe('ABCD-EFGH-JKMN');
  });

  it('normalizes only a complete code', () => {
    expect(normalizePairingCode('abcd-efgh-jkmn')).toBe('ABCDEFGHJKMN');
    expect(normalizePairingCode('ABCD-EFGH-JKM')).toBeUndefined();
  });

  it('derives the PSK and the slot hash as D6 specifies', async () => {
    const empty = new Uint8Array(0);
    const psk = await hkdfSha256(utf8('ABCDEFGHJKMN'), empty, utf8('rc/v1/pair-psk'), 32);
    const codeHash = toBase64Url(await hkdfSha256(psk, empty, utf8('rc/v1/pair-slot'), 32));
    await expect(pairingSecrets('ABCDEFGHJKMN')).resolves.toEqual({ psk, codeHash });
    expect(codeHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
