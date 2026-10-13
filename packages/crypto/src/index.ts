export { CryptoError } from './errors.js';
export type { CryptoErrorCode } from './errors.js';
export { bytesEqual, concatBytes, fromHex, utf8 } from './bytes.js';

export { webCryptoRandom } from './adapters/web-crypto-random.js';
export { probeWebCrypto } from './primitives/probe.js';
export type { WebCryptoCapability, WebCryptoProbe } from './primitives/probe.js';
export { sha256 } from './primitives/sha256.js';
export { hkdfSha256 } from './primitives/hkdf.js';
export {
  aesGcmDecrypt,
  aesGcmEncrypt,
  AES_GCM_TAG_LENGTH,
  importAesGcmKey,
} from './primitives/aes-gcm.js';
export {
  generateX25519KeyPair,
  x25519,
  X25519_KEY_LENGTH,
  x25519KeyPairFromPrivateKey,
} from './primitives/x25519.js';
export type { X25519KeyPair } from './primitives/x25519.js';

export { CipherState, DEFAULT_MESSAGE_LIMIT } from './noise/cipher-state.js';
export { KK, protocolName, XXPSK0 } from './noise/patterns.js';
export type { HandshakePattern, Token } from './noise/patterns.js';
export { HandshakeState, NOISE_MAX_MESSAGE_LENGTH, PSK_LENGTH } from './noise/handshake-state.js';
export type { HandshakeOptions, HandshakeResult } from './noise/handshake-state.js';

export {
  MAX_FRAME_BYTES,
  MAX_PADDED_BYTES,
  MAX_PLAINTEXT_BYTES,
  PADDING_BLOCK,
} from './session/padding.js';
export { headerAad, TransportSession } from './session/transport-session.js';
export type { EnvelopeHeader } from './session/transport-session.js';
export { pairingPrologue, sessionPrologue } from './session/prologue.js';
export type { PairingPrologueInput, SessionPrologueInput } from './session/prologue.js';

export { pairingFingerprint } from './fingerprint.js';
export { deriveNotificationKey, NOTIFICATION_KEY_INFO } from './notification-key.js';
export {
  MAX_PUSH_SUMMARY_BYTES,
  MAX_PUSH_SUMMARY_PLAINTEXT_BYTES,
  openPushSummary,
  sealPushSummary,
} from './push-summary.js';
