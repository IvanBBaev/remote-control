import { seededRandom } from '@remote-control/fake-claude-code';
import { describe, expect, it } from 'vitest';

import {
  PAIRING_CODE_LENGTH,
  formatPairingCode,
  generatePairingCode,
  normalizePairingCode,
  pairingPsk,
  pairingQrText,
  slotCodeHash,
} from './pairing-code.js';

describe('pairing code', () => {
  it('draws 12 Crockford characters', () => {
    const random = seededRandom(5);
    const codes = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const code = generatePairingCode(random);
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
      codes.add(code);
    }
    expect(codes.size).toBe(50);
    expect(PAIRING_CODE_LENGTH).toBe(12);
  });

  it('formats and normalises', () => {
    expect(formatPairingCode('ABCDEFGHJKMN')).toBe('ABCD-EFGH-JKMN');
    expect(normalizePairingCode('abcd-efgh-jkmn')).toBe('ABCDEFGHJKMN');
    expect(normalizePairingCode(' oiL0 1234 5678 ')).toBe('011012345678');
    expect(normalizePairingCode('ABCD-EFGH-JKM')).toBeUndefined();
    expect(normalizePairingCode('ABCD-EFGH-JKMU')).toBeUndefined();
  });

  it('derives the same PSK and slot hash from equal codes only', async () => {
    const psk = await pairingPsk('ABCDEFGHJKMN');
    expect(psk).toHaveLength(32);
    expect(await pairingPsk('ABCDEFGHJKMN')).toEqual(psk);
    expect(await pairingPsk('ABCDEFGHJKMP')).not.toEqual(psk);
    const hash = await slotCodeHash(psk);
    expect(hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await slotCodeHash(await pairingPsk('ABCDEFGHJKMP'))).not.toBe(hash);
  });

  it('builds the QR text', () => {
    expect(pairingQrText('relay.example', 'id', new Uint8Array(32).fill(0xff))).toBe(
      `rc1:relay.example:id:${'_'.repeat(42)}8`,
    );
  });
});
