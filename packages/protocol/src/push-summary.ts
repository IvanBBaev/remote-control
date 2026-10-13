import { z } from 'zod';

import { RequestId } from './ids.js';
import { MAX_TOOL_LABEL_LENGTH } from './tool-labels.js';

/**
 * Largest encoded summary in UTF-8 bytes: the 1 KiB sealed blob (D5) minus the 12-byte
 * nonce and the 16-byte GCM tag.
 */
export const MAX_PUSH_SUMMARY_JSON_BYTES = 996;

/**
 * What a push may say about a pending request (D5, M1-06): the project, the tool's plain
 * label and one short line — never file contents or secrets. The agent seals it under the
 * pairing's notification key; only the phone's service worker reads it. Keys are short
 * because the whole push payload is size-capped.
 */
export const PushSummary = z.strictObject({
  v: z.literal(1),
  /** Project (the session's working folder name). */
  p: z.string().min(1).max(128).optional(),
  /** Plain tool label (`toolLabel`), the notification's headline. */
  l: z.string().min(1).max(MAX_TOOL_LABEL_LENGTH),
  /** One short, secret-masked line (a command's first line, a file path, a pattern). */
  s: z.string().min(1).max(240).optional(),
  /** The request id, for the notification's deep link. */
  r: RequestId.optional(),
  /**
   * A turn notice instead of a pending request (M2-08): the turn finished, or the agent
   * needs input in the terminal. Nothing to decide, so the notification opens the app.
   */
  k: z.enum(['finished', 'input']).optional(),
});
export type PushSummary = z.infer<typeof PushSummary>;

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** `text` cut to `max` code points, the last one an ellipsis. */
function cut(text: string, max: number): string {
  return `${Array.from(text)
    .slice(0, max - 1)
    .join('')}…`;
}

/**
 * Encodes a summary as JSON of at most {@link MAX_PUSH_SUMMARY_JSON_BYTES} bytes: the line
 * shrinks first, then the project. The label alone always fits (200 code points).
 */
export function encodePushSummary(summary: PushSummary): string {
  const current: Record<string, unknown> = { ...PushSummary.parse(summary) };
  for (const field of ['s', 'p'] as const) {
    while (byteLength(JSON.stringify(current)) > MAX_PUSH_SUMMARY_JSON_BYTES) {
      const text = current[field];
      if (typeof text !== 'string') break;
      const length = Array.from(text).length;
      if (length <= 1) delete current[field];
      else current[field] = cut(text, length - 1);
    }
  }
  return JSON.stringify(current);
}

/** Parses a decrypted summary; `undefined` for anything that is not a valid summary. */
export function decodePushSummary(text: string): PushSummary | undefined {
  try {
    const parsed = PushSummary.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
