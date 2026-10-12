/** A Noise message token (Noise §7). */
export type Token = 'e' | 's' | 'ee' | 'es' | 'se' | 'ss' | 'psk';

/**
 * A Noise handshake pattern. Pre-messages may only carry `s` (all this package needs).
 * Messages alternate, starting with the initiator.
 */
export interface HandshakePattern {
  readonly name: string;
  readonly initiatorPreMessage: readonly 's'[];
  readonly responderPreMessage: readonly 's'[];
  readonly messages: readonly (readonly Token[])[];
}

/** `KK` (Noise §7.4): both statics known in advance. Phone ↔ agent sessions (D3). */
export const KK: HandshakePattern = {
  name: 'KK',
  initiatorPreMessage: ['s'],
  responderPreMessage: ['s'],
  messages: [
    ['e', 'es', 'ss'],
    ['e', 'ee', 'se'],
  ],
};

/** `XXpsk0` (Noise §9.3): mutual static exchange bound to a pairing PSK (D3, D6). */
export const XXPSK0: HandshakePattern = {
  name: 'XXpsk0',
  initiatorPreMessage: [],
  responderPreMessage: [],
  messages: [
    ['psk', 'e'],
    ['e', 'ee', 's', 'es'],
    ['s', 'se'],
  ],
};

/** The full Noise protocol name, e.g. `Noise_KK_25519_AESGCM_SHA256`. */
export function protocolName(pattern: HandshakePattern): string {
  return `Noise_${pattern.name}_25519_AESGCM_SHA256`;
}
