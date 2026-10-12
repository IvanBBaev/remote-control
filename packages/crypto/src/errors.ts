/** Why a crypto operation refused to proceed. */
export type CryptoErrorCode =
  /** WebCrypto, or one of the algorithms D3 needs, is not available on this platform. */
  | 'unsupported'
  /** A caller passed a malformed key, length or option; a programming error. */
  | 'invalid_argument'
  /** A handshake message failed to parse or authenticate; the handshake is dead. */
  | 'handshake_failed'
  /** A transport frame failed to authenticate, was out of order, or was malformed. */
  | 'decrypt_failed'
  /** A plaintext or ciphertext exceeds the 64 KiB frame limit. */
  | 'frame_too_large'
  /** The per-direction message limit is reached; the peers must re-handshake. */
  | 'nonce_exhausted'
  /** The session was closed (by a failure, a revocation or a reconnect). */
  | 'session_closed';

/**
 * The only error type this package throws on purpose. Messages never contain key
 * material or plaintext, so a `CryptoError` is always safe to log.
 */
export class CryptoError extends Error {
  readonly code: CryptoErrorCode;

  constructor(code: CryptoErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CryptoError';
    this.code = code;
  }
}
