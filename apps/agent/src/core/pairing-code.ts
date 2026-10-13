import { PSK_LENGTH, hkdfSha256, utf8 } from '@remote-control/crypto';
import { toBase64Url } from '@remote-control/protocol';

import type { Random } from '../ports/random.js';

/** Crockford base32: no I, L, O or U, so the code survives being read aloud (D6). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 12 characters × 5 bits = 60 bits (D6). */
export const PAIRING_CODE_LENGTH = 12;
const PSK_INFO = utf8('rc/v1/pair-psk');
const SLOT_INFO = utf8('rc/v1/pair-slot');
const EMPTY = new Uint8Array(0);

/** A fresh 12-character pairing code, 60 bits from the `Random` port. */
export function generatePairingCode(random: Random): string {
  const bytes = random.bytes(8);
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += CROCKFORD[Number(bits & 31n)];
    bits >>= 5n;
  }
  return code;
}

/** `ABCD-EFGH-JKMN`: how the agent prints the code. */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

/**
 * The code as typed, in canonical form: upper case, without spaces and dashes, with the
 * Crockford look-alikes mapped (O → 0, I and L → 1). `undefined` when it is not 12 valid
 * characters.
 */
export function normalizePairingCode(input: string): string | undefined {
  const code = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (code.length !== PAIRING_CODE_LENGTH) return undefined;
  for (const char of code) if (!CROCKFORD.includes(char)) return undefined;
  return code;
}

/** The XXpsk0 pre-shared key: `HKDF-SHA-256(code, "", "rc/v1/pair-psk")`, 32 bytes (D6). */
export function pairingPsk(code: string): Promise<Uint8Array> {
  return hkdfSha256(utf8(code), EMPTY, PSK_INFO, PSK_LENGTH);
}

/**
 * What the relay stores to match the phone to the slot: a one-way derivation of the PSK
 * (`HKDF(psk, "", "rc/v1/pair-slot")`, unpadded base64url), so the relay never learns
 * the PSK itself (I3). A phone that scanned the QR (which carries the PSK) derives the
 * same value as one that typed the code.
 */
export async function slotCodeHash(psk: Uint8Array): Promise<string> {
  return toBase64Url(await hkdfSha256(psk, EMPTY, SLOT_INFO, 32));
}

/** `rc1:<relay-host>:<agent_device_id>:<psk base64url>` (02 §5.3; QR scanning is M2). */
export function pairingQrText(relayHost: string, agentDeviceId: string, psk: Uint8Array): string {
  return `rc1:${relayHost}:${agentDeviceId}:${toBase64Url(psk)}`;
}
