/** D5: the push metadata (everything but `sum`) stays under 200 bytes. */
export const MAX_PUSH_PAYLOAD_BYTES = 199;

/** D5 (M1): the whole payload, the sealed summary included, stays within 3.5 KB. */
export const MAX_PUSH_PAYLOAD_WITH_SUMMARY_BYTES = 3500;

/**
 * `{t:"pending", rid, dev, exp, sum?}`: request id, agent device name, expiry (epoch ms)
 * and, from M1, the agent's sealed summary (base64), which only the phone can open.
 */
export interface PendingPushPayload {
  readonly t: 'pending';
  readonly rid: string;
  readonly dev: string;
  readonly exp: number | null;
  readonly sum?: string;
}

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

/**
 * Serialises the push payload (D5). The device name is the only free-form field; it is
 * shortened (by code point, with an ellipsis) until the metadata fits
 * {@link MAX_PUSH_PAYLOAD_BYTES}. A sealed summary is copied verbatim; the envelope schema
 * caps it at 1 368 base64 characters, so the payload stays well within
 * {@link MAX_PUSH_PAYLOAD_WITH_SUMMARY_BYTES}.
 */
export function encodePendingPayload(
  rid: string,
  dev: string,
  exp: number | null,
  sum?: string,
): string {
  const encode = (name: string, summary?: string) =>
    JSON.stringify({
      t: 'pending',
      rid,
      dev: name,
      exp,
      ...(summary === undefined ? {} : { sum: summary }),
    } satisfies PendingPushPayload);
  let name = dev;
  const points = [...dev];
  while (byteLength(encode(name)) > MAX_PUSH_PAYLOAD_BYTES && points.length > 0) {
    points.pop();
    name = `${points.join('')}…`;
  }
  if (byteLength(encode(name)) > MAX_PUSH_PAYLOAD_BYTES) name = '';
  return encode(name, sum);
}

/** RFC 8030 topics are at most 32 URL-safe base64 characters: the UUID without hyphens. */
export function pushTopic(rid: string): string {
  return rid.replaceAll('-', '').slice(0, 32);
}

/** Push services hold a message at most this long when the request has no expiry. */
export const MAX_PUSH_TTL_SECONDS = 60 * 60;

/**
 * `TTL` = the request's remaining lifetime in whole seconds (rounded up), capped at
 * {@link MAX_PUSH_TTL_SECONDS}; `0` means expired, and then nothing is sent (D5).
 */
export function pushTtlSeconds(expiresAt: number | null, now: number): number {
  if (expiresAt === null) return MAX_PUSH_TTL_SECONDS;
  return Math.min(MAX_PUSH_TTL_SECONDS, Math.max(0, Math.ceil((expiresAt - now) / 1000)));
}
