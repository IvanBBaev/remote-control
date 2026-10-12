const MAX_LENGTH = 300;

/**
 * Makes an error message safe to leave the relay (D19). Error messages are written by
 * code, but some quote their input (`JSON.parse`, `pg`, URL parsers), so anything that
 * could be a token, ciphertext, endpoint or quoted payload is replaced:
 * URLs, e-mail addresses, quoted strings over 8 characters (greedy, so quotes inside
 * the payload do not end it early) and long base64/hex-like runs.
 */
export function scrubMessage(message: string): string {
  return message
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]')
    .replace(/[^\s@"'`]+@[^\s@"'`]+\.[^\s@"'`]+/g, '[email]')
    .replace(/(["'`]).{8,}\1/g, '$1[redacted]$1')
    .replace(/[A-Za-z0-9_\-+/=]{20,}/g, '[redacted]')
    .slice(0, MAX_LENGTH);
}
