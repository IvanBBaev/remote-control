import { canonicalJson } from './canonical-json.js';
import type { Frame } from './frame.js';

/** Encodes a frame as byte-stable canonical JSON (sorted keys, no whitespace). */
export function encodeFrame(frame: Frame): string {
  return canonicalJson(frame);
}
