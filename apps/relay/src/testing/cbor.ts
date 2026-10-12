/** The CBOR subset a WebAuthn authenticator emits (RFC 8949): ints, bytes, text, maps. */
export type CborValue =
  | number
  | string
  | Uint8Array
  | ReadonlyMap<CborValue, CborValue>
  | { readonly [key: string]: CborValue };

function head(major: number, length: number): number[] {
  if (length < 24) return [(major << 5) | length];
  if (length < 0x100) return [(major << 5) | 24, length];
  if (length < 0x10000) return [(major << 5) | 25, length >> 8, length & 0xff];
  return [
    (major << 5) | 26,
    (length >>> 24) & 0xff,
    (length >> 16) & 0xff,
    (length >> 8) & 0xff,
    length & 0xff,
  ];
}

/** Encodes a value; maps keep insertion order (enough for COSE keys and attestation objects). */
export function encodeCbor(value: CborValue): Uint8Array {
  const out: number[] = [];
  const write = (item: CborValue): void => {
    if (typeof item === 'number') {
      out.push(...(item >= 0 ? head(0, item) : head(1, -1 - item)));
    } else if (typeof item === 'string') {
      const bytes = new TextEncoder().encode(item);
      out.push(...head(3, bytes.length), ...bytes);
    } else if (item instanceof Uint8Array) {
      out.push(...head(2, item.length), ...item);
    } else {
      const entries: [CborValue, CborValue][] =
        item instanceof Map
          ? [...(item as ReadonlyMap<CborValue, CborValue>)]
          : Object.entries(item);
      out.push(...head(5, entries.length));
      for (const [key, entry] of entries) {
        write(key);
        write(entry);
      }
    }
  };
  write(value);
  return Uint8Array.from(out);
}
