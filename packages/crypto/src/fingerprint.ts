import { concatBytes } from './bytes.js';
import { CryptoError } from './errors.js';
import { sha256 } from './primitives/sha256.js';
import { X25519_KEY_LENGTH } from './primitives/x25519.js';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Pairing confirmation code (02 §5.3): `base32(SHA-256(phone_pub || agent_pub))[0:8]`,
 * RFC 4648 alphabet, shown as `ABCD-EFGH` (40 bits). Both screens show it after the
 * XXpsk0 handshake; the user confirms they match.
 */
export async function pairingFingerprint(
  phoneStaticPublicKey: Uint8Array,
  agentStaticPublicKey: Uint8Array,
): Promise<string> {
  if (
    phoneStaticPublicKey.length !== X25519_KEY_LENGTH ||
    agentStaticPublicKey.length !== X25519_KEY_LENGTH
  ) {
    throw new CryptoError('invalid_argument', 'pairingFingerprint: keys must be 32 bytes');
  }
  const digest = await sha256(concatBytes(phoneStaticPublicKey, agentStaticPublicKey));
  // The first 40 bits (5 bytes) are exactly 8 base32 characters.
  let bits = 0n;
  for (const byte of digest.subarray(0, 5)) bits = (bits << 8n) | BigInt(byte);
  let code = '';
  for (let shift = 35n; shift >= 0n; shift -= 5n) code += BASE32[Number((bits >> shift) & 31n)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
