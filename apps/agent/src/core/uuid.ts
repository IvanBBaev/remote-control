import { toHex } from '@remote-control/protocol';

import type { Clock } from '../ports/clock.js';
import type { Random } from '../ports/random.js';

function format(bytes: Uint8Array): string {
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A random (version 4) UUID drawn from the `Random` port; request ids (D7). */
export function uuidV4(random: Random): string {
  const bytes = random.bytes(16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return format(bytes);
}

/** A time-ordered (version 7) UUID; envelope ids (D14). */
export function uuidV7(clock: Clock, random: Random): string {
  const bytes = random.bytes(16);
  let ms = clock.now();
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return format(bytes);
}
