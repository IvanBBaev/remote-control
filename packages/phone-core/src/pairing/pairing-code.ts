import { hkdfSha256, PSK_LENGTH, utf8 } from '@remote-control/crypto';
import { toBase64Url } from '@remote-control/protocol';

/** Crockford base32: no I, L, O or U (D6). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** The code `remotectl pair` prints: 12 Crockford characters, 60 bits (D6). */
export const PAIRING_CODE_LENGTH = 12;
const GROUP = 4;
const EMPTY = new Uint8Array(0);

/**
 * The characters of a typed or pasted code, read the Crockford way: case-insensitive,
 * O as 0, I and L as 1; spaces, dashes and anything outside the alphabet dropped.
 */
export function pairingCodeCharacters(input: string): string {
  return [...input.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1')]
    .filter((char) => CROCKFORD.includes(char))
    .join('')
    .slice(0, PAIRING_CODE_LENGTH);
}

/** The input as the user should see it: `ABCD-EFGH-JKMN`, grouped while typing. */
export function formatPairingCode(input: string): string {
  const chars = pairingCodeCharacters(input);
  const groups: string[] = [];
  for (let i = 0; i < chars.length; i += GROUP) groups.push(chars.slice(i, i + GROUP));
  return groups.join('-');
}

/** The normalized 12-character code, or `undefined` while it is incomplete. */
export function normalizePairingCode(input: string): string | undefined {
  const chars = pairingCodeCharacters(input);
  return chars.length === PAIRING_CODE_LENGTH ? chars : undefined;
}

export interface PairingSecrets {
  /** The XXpsk0 pre-shared key; never leaves the phone. */
  readonly psk: Uint8Array;
  /** What the relay matches the slot by; the code itself never reaches it (I1). */
  readonly codeHash: string;
}

/** The phone's derivations from a normalized code (D6), the same as the agent's. */
export async function pairingSecrets(code: string): Promise<PairingSecrets> {
  return pskSecrets(await hkdfSha256(utf8(code), EMPTY, utf8('rc/v1/pair-psk'), PSK_LENGTH));
}

/** The slot hash for a PSK the phone already has, e.g. from the scanned QR (M2-04). */
export async function pskSecrets(psk: Uint8Array): Promise<PairingSecrets> {
  const codeHash = toBase64Url(await hkdfSha256(psk, EMPTY, utf8('rc/v1/pair-slot'), 32));
  return { psk, codeHash };
}
