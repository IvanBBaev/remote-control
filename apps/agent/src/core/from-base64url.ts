import { toBase64Url } from '@remote-control/protocol';

/**
 * Decodes unpadded base64url (RFC 4648 §5), the inverse of protocol's `toBase64Url`.
 * Returns `undefined` for anything that is not canonical base64url.
 */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return undefined;
  const base64 = text.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  // Reject spare non-zero bits, so every byte string has exactly one accepted text.
  return toBase64Url(bytes) === text ? bytes : undefined;
}
