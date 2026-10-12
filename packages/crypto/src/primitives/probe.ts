import { fromHex } from '../bytes.js';

/** The WebCrypto capabilities D3 requires, each checked by a real operation. */
export type WebCryptoCapability = 'subtle' | 'sha256' | 'hmac' | 'hkdf' | 'aes-gcm' | 'x25519';

/** Result of {@link probeWebCrypto}: `ok` iff nothing is `missing`. */
export interface WebCryptoProbe {
  readonly ok: boolean;
  readonly missing: readonly WebCryptoCapability[];
}

// RFC 7748 §6.1: Alice's private key (PKCS#8-wrapped) and public key. The probe derives
// the public key and compares, so a platform that "supports" X25519 wrongly also fails.
const ALICE_PKCS8 = fromHex(
  '302e020100300506032b656e04220420' +
    '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a',
);
const ALICE_PUBLIC = '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a';
const BASE_POINT = fromHex('09'.padEnd(64, '0'));

async function x25519Works(subtle: SubtleCrypto): Promise<void> {
  const algorithm = { name: 'X25519' };
  const privateKey = await subtle.importKey('pkcs8', ALICE_PKCS8, algorithm, false, ['deriveBits']);
  const base = await subtle.importKey('raw', BASE_POINT, algorithm, true, []);
  const bits = await subtle.deriveBits({ name: 'X25519', public: base }, privateKey, 256);
  const hex = Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, '0')).join('');
  if (hex !== ALICE_PUBLIC) throw new Error('X25519 returned a wrong result');
}

/**
 * Checks, by exercising each algorithm once, that the platform's WebCrypto can run this
 * package (D3: no pure-JS fallback). The phone shows "browser not supported" and the
 * daemon refuses to start when `ok` is false. Uses no randomness.
 */
export async function probeWebCrypto(
  subtle: SubtleCrypto | undefined = (globalThis.crypto as Crypto | undefined)?.subtle,
): Promise<WebCryptoProbe> {
  if (subtle === undefined) return { ok: false, missing: ['subtle'] };
  const key = new Uint8Array(32).fill(1);
  const checks: readonly [WebCryptoCapability, () => Promise<unknown>][] = [
    ['sha256', () => subtle.digest('SHA-256', key)],
    [
      'hmac',
      async () => {
        const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
          'sign',
        ]);
        return subtle.sign('HMAC', k, key);
      },
    ],
    [
      'hkdf',
      async () => {
        const k = await subtle.importKey('raw', key, 'HKDF', false, ['deriveBits']);
        const params = { name: 'HKDF', hash: 'SHA-256', salt: key, info: key };
        return subtle.deriveBits(params, k, 256);
      },
    ],
    [
      'aes-gcm',
      async () => {
        const k = await subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
        return subtle.encrypt({ name: 'AES-GCM', iv: key.subarray(0, 12) }, k, key);
      },
    ],
    ['x25519', () => x25519Works(subtle)],
  ];
  const missing: WebCryptoCapability[] = [];
  for (const [capability, check] of checks) {
    try {
      await check();
    } catch {
      missing.push(capability);
    }
  }
  return { ok: missing.length === 0, missing };
}
