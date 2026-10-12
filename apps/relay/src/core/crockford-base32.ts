const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Crockford base32 for codes a person reads, types or pastes (invite and recovery
 * codes): no padding, upper case, and decoding forgives case, `-`, spaces and the
 * look-alikes `O`→0, `I`/`L`→1.
 */
export const crockfordBase32 = {
  encode(bytes: Uint8Array): string {
    let out = '';
    let buffer = 0;
    let bits = 0;
    for (const byte of bytes) {
      buffer = (buffer << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        out += ALPHABET[(buffer >> bits) & 31];
      }
      buffer &= (1 << bits) - 1;
    }
    if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
    return out;
  },

  /** The canonical form of a typed code, or `null` when it holds a non-alphabet character. */
  normalize(text: string): string | null {
    const cleaned = text
      .toUpperCase()
      .replace(/[\s-]/g, '')
      .replace(/O/g, '0')
      .replace(/[IL]/g, '1');
    return /^[0-9A-HJKMNP-TV-Z]*$/.test(cleaned) ? cleaned : null;
  },
};
