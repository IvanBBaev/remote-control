// Imported first by the root layout: fills in the web platform APIs the shared packages
// expect and Hermes lacks, and switches the crypto package to its pure-JS backend
// (ADR 0017). Nothing here may run after a key is created.
import { setCryptoBackend } from '@remote-control/crypto';
import { nobleBackend } from '@remote-control/crypto/noble';

import { installRandomValues } from './system-random';

setCryptoBackend(nobleBackend);

const scope = globalThis as unknown as {
  crypto?: { getRandomValues?: Crypto['getRandomValues']; subtle?: SubtleCrypto };
  TextDecoder?: unknown;
};

installRandomValues(scope);

// `@remote-control/protocol` hashes with `crypto.subtle.digest('SHA-256')`.
const crypto = scope.crypto!;
if (crypto.subtle === undefined) {
  const digest = async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
    const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
    if (name.toUpperCase() !== 'SHA-256') throw new Error(`digest ${name} is not available`);
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    return (await nobleBackend.sha256(bytes)).buffer;
  };
  crypto.subtle = { digest } as unknown as SubtleCrypto;
}

// The relay API bounds every request with `AbortSignal.timeout`.
if (typeof AbortSignal.timeout !== 'function') {
  AbortSignal.timeout = (ms: number) => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort(new Error('TimeoutError'));
    }, ms);
    return controller.signal;
  };
}

// The realtime client decodes UTF-8 frames with `TextDecoder`.
if (scope.TextDecoder === undefined) {
  class Utf8Decoder {
    readonly encoding = 'utf-8';
    decode(input?: BufferSource): string {
      if (input === undefined) return '';
      const bytes = ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : new Uint8Array(input);
      let escaped = '';
      for (const byte of bytes) escaped += `%${byte.toString(16).padStart(2, '0')}`;
      return decodeURIComponent(escaped);
    }
  }
  scope.TextDecoder = Utf8Decoder;
}
