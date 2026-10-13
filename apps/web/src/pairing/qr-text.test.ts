import { describe, expect, it } from 'vitest';

import { parsePairingQr } from './qr-text.js';

const AGENT = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b';
/** 32 bytes 0x00, 0x07, 0x0e, … as the agent's `pairingQrText` writes them. */
const PSK = Uint8Array.from({ length: 32 }, (_, i) => (i * 7) & 0xff);
const PSK_TEXT = 'AAcOFRwjKjE4P0ZNVFtiaXB3foWMk5qhqK-2vcTL0tk';
/** The text the agent's terminal QR decodes to (apps/agent pairing-code.test.ts). */
const FIXTURE = `rc1:127.0.0.1:8787:${AGENT}:${PSK_TEXT}`;

describe('parsePairingQr', () => {
  it('reads the fixture QR text, host port included', () => {
    expect(parsePairingQr(FIXTURE)).toEqual({
      relayHost: '127.0.0.1:8787',
      agentDeviceId: AGENT,
      psk: PSK,
    });
    expect(parsePairingQr(` rc1:relay.example.com:${AGENT}:${PSK_TEXT}\n`)).toMatchObject({
      relayHost: 'relay.example.com',
    });
  });

  it.each([
    ['another scheme', 'https://relay.example.com'],
    ['no prefix', `relay.example.com:${AGENT}:${PSK_TEXT}`],
    ['a missing field', `rc1:${AGENT}:${PSK_TEXT}`],
    ['an empty host', `rc1::${AGENT}:${PSK_TEXT}`],
    ['a bad host', `rc1:relay/example:${AGENT}:${PSK_TEXT}`],
    ['a bad device id', `rc1:relay.example.com:agent-1:${PSK_TEXT}`],
    ['a short key', `rc1:relay.example.com:${AGENT}:${PSK_TEXT.slice(1)}`],
    ['a padded key', `rc1:relay.example.com:${AGENT}:${PSK_TEXT}=`],
    ['standard base64', `rc1:relay.example.com:${AGENT}:${PSK_TEXT.replace('-', '+')}`],
    ['a non-canonical last character', `rc1:relay.example.com:${AGENT}:${PSK_TEXT.slice(0, -1)}l`],
  ])('refuses %s', (_, text) => {
    expect(parsePairingQr(text)).toBeUndefined();
  });
});
