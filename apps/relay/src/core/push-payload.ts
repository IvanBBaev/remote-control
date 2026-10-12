/** D5: the M0 push payload is metadata only and stays under 200 bytes. */
export const MAX_PUSH_PAYLOAD_BYTES = 199;

/** `{t:"pending", rid, dev, exp}`: request id, agent device name, expiry (epoch ms). */
export interface PendingPushPayload {
  readonly t: 'pending';
  readonly rid: string;
  readonly dev: string;
  readonly exp: number | null;
}

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

/**
 * Serialises the metadata-only payload (D5). The device name is the only free-form field;
 * it is shortened (by code point, with an ellipsis) until the JSON fits
 * {@link MAX_PUSH_PAYLOAD_BYTES}.
 */
export function encodePendingPayload(rid: string, dev: string, exp: number | null): string {
  const encode = (name: string) =>
    JSON.stringify({ t: 'pending', rid, dev: name, exp } satisfies PendingPushPayload);
  let json = encode(dev);
  if (byteLength(json) <= MAX_PUSH_PAYLOAD_BYTES) return json;
  const points = [...dev];
  while (points.length > 0) {
    points.pop();
    json = encode(`${points.join('')}…`);
    if (byteLength(json) <= MAX_PUSH_PAYLOAD_BYTES) return json;
  }
  return encode('');
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
