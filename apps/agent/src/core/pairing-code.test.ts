import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { seededRandom } from '@remote-control/fake-claude-code';
import { describe, expect, it } from 'vitest';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';

import {
  PAIRING_CODE_LENGTH,
  formatPairingCode,
  generatePairingCode,
  normalizePairingCode,
  pairingPsk,
  pairingQrText,
  renderPairingQr,
  slotCodeHash,
} from './pairing-code.js';

const SCALE = 4;

/** Rasterises the terminal QR as a grayscale PGM, dark modules drawn as on a dark theme. */
function terminalQrToPgm(lines: string[], darkTheme: boolean): Uint8Array {
  const columns = [...lines[0]!].length;
  const width = columns * SCALE;
  const height = lines.length * 2 * SCALE;
  const pixels = new Uint8Array(width * height);
  lines.forEach((line, row) => {
    [...line].forEach((char, column) => {
      const top = char === '█' || char === '▀';
      const bottom = char === '█' || char === '▄';
      for (let y = 0; y < 2 * SCALE; y++) {
        const dark = y < SCALE ? top : bottom;
        const value = dark === darkTheme ? 255 : 0;
        const offset = (row * 2 * SCALE + y) * width + column * SCALE;
        pixels.fill(value, offset, offset + SCALE);
      }
    });
  });
  const header = new TextEncoder().encode(`P5\n${width} ${height}\n255\n`);
  const image = new Uint8Array(header.length + pixels.length);
  image.set(header);
  image.set(pixels, header.length);
  return image;
}

async function decodeQr(image: Uint8Array): Promise<string[]> {
  const require = createRequire(import.meta.url);
  const wasm = readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm'));
  await prepareZXingModule({
    overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.length) },
    fireImmediately: true,
  });
  const results = await readBarcodes(image, { formats: ['QRCode'] });
  return results.map((result) => result.text);
}

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

  it('draws a terminal QR that decodes back to the text on light and dark themes', async () => {
    const text = pairingQrText(
      '127.0.0.1:8787',
      '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b',
      new Uint8Array(32).map((_, i) => i * 7),
    );
    const lines = renderPairingQr(text);
    for (const line of lines) expect(line).toMatch(/^[ █▀▄]+$/u);
    expect(await decodeQr(terminalQrToPgm(lines, false))).toEqual([text]);
    expect(await decodeQr(terminalQrToPgm(lines, true))).toEqual([text]);
  });
});
