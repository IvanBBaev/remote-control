import type { Random } from '@remote-control/protocol';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** RFC 4122 version-4 UUID drawn from the injected Random port. */
export function uuidV4(random: Random): string {
  const bytes = random.bytes(16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const h = hex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Opaque id with a prefix, e.g. `toolu_0123abcd…`, drawn from the injected Random port. */
export function prefixedId(prefix: string, random: Random, bytes = 12): string {
  return `${prefix}${hex(random.bytes(bytes))}`;
}
