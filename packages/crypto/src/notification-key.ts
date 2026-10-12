import { utf8 } from './bytes.js';
import { importAesGcmKey } from './primitives/aes-gcm.js';
import { hkdfSha256 } from './primitives/hkdf.js';
import { x25519 } from './primitives/x25519.js';

/** HKDF `info` of the notification key (D5). */
export const NOTIFICATION_KEY_INFO = 'rc/v1/push';

/**
 * Per-pairing notification key (D5, used from M1-06):
 * `HKDF-SHA-256(ikm = X25519(own_static, peer_static), salt = empty, info = "rc/v1/push")`,
 * 32 bytes, returned as a non-extractable AES-256-GCM key with only the given usages
 * (the service worker holds it decrypt-only). Both ends of a pairing derive the same key.
 *
 * Sign-off against 02 §5.2: the key is static, so push summaries have no forward secrecy
 * — accepted, because they are one-line summaries that never carry file contents or
 * secrets, and the key rotates whenever the pair re-pairs (new statics). It never
 * protects session traffic: the static–static DH also feeds KK's `ss`, but there it is
 * mixed with ephemeral DHs through Noise's own HKDF chain, while this key comes from a
 * separate RFC 5869 HKDF with its own `info`, so neither key reveals the other.
 */
export async function deriveNotificationKey(
  ownStaticPrivateKey: CryptoKey,
  peerStaticPublicKey: Uint8Array,
  usages: readonly ('encrypt' | 'decrypt')[],
): Promise<CryptoKey> {
  const shared = await x25519(ownStaticPrivateKey, peerStaticPublicKey);
  const raw = await hkdfSha256(shared, new Uint8Array(0), utf8(NOTIFICATION_KEY_INFO), 32);
  return importAesGcmKey(raw, usages);
}
