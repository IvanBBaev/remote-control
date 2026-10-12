import { canonicalJson } from './canonical-json.js';

const encoder = new TextEncoder();

/** SHA-256 over the UTF-8 bytes of a value's canonical JSON, via WebCrypto (D3). */
export async function digestCanonical(value: unknown): Promise<Uint8Array> {
  const bytes = encoder.encode(canonicalJson(value));
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
}
