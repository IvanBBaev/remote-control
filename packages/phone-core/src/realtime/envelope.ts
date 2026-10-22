import { toHex } from '@remote-control/protocol';
import type { Envelope, Random } from '@remote-control/protocol';

/** An envelope without its payload: the AEAD associated data (D3). */
export type EnvelopeHeader = Omit<Envelope, 'payload'>;

export function header(envelope: Envelope): EnvelopeHeader {
  const { payload, ...rest } = envelope;
  return rest;
}

/** A UUIDv7 (RFC 9562): 48-bit Unix ms, then random bits. */
export function uuidV7(now: number, random: Random): string {
  const bytes = random.bytes(16);
  let ms = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
