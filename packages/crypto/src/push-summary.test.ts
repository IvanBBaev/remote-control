import { describe, expect, it } from 'vitest';

import { utf8 } from './bytes.js';
import { deriveNotificationKey } from './notification-key.js';
import {
  MAX_PUSH_SUMMARY_BYTES,
  MAX_PUSH_SUMMARY_PLAINTEXT_BYTES,
  openPushSummary,
  sealPushSummary,
} from './push-summary.js';
import { seededRandom, staticKey } from '../test/support.js';

const code = (expected: string) =>
  expect.objectContaining({ name: 'CryptoError', code: expected }) as unknown;

const ENVELOPE = '0190a1b2-1111-7000-8000-000000000001';
const OTHER_ENVELOPE = '0190a1b2-1111-7000-8000-000000000002';

async function keys() {
  const phone = await staticKey(1);
  const agent = await staticKey(2);
  return {
    seal: await deriveNotificationKey(agent.privateKey, phone.publicKey, ['encrypt']),
    open: await deriveNotificationKey(phone.privateKey, agent.publicKey, ['decrypt']),
  };
}

describe('push summary (D5)', () => {
  it('round-trips under the pairing notification key', async () => {
    const { seal, open } = await keys();
    const sealed = await sealPushSummary(seal, ENVELOPE, utf8('{"l":"Bash"}'), seededRandom(7));
    expect(sealed.length).toBe(12 + 12 + 16);
    expect(await openPushSummary(open, ENVELOPE, sealed)).toEqual(utf8('{"l":"Bash"}'));
  });

  it('uses a fresh random nonce per seal', async () => {
    const { seal } = await keys();
    const random = seededRandom(7);
    const a = await sealPushSummary(seal, ENVELOPE, utf8('x'), random);
    const b = await sealPushSummary(seal, ENVELOPE, utf8('x'), random);
    expect(a.subarray(0, 12)).not.toEqual(b.subarray(0, 12));
  });

  it('is bound to the envelope id, so the relay cannot move it to another push', async () => {
    const { seal, open } = await keys();
    const sealed = await sealPushSummary(seal, ENVELOPE, utf8('x'), seededRandom(7));
    await expect(openPushSummary(open, OTHER_ENVELOPE, sealed)).rejects.toThrow(
      code('decrypt_failed'),
    );
  });

  it('rejects a tampered, truncated or oversized blob', async () => {
    const { seal, open } = await keys();
    const sealed = await sealPushSummary(seal, ENVELOPE, utf8('x'), seededRandom(7));
    const flipped = sealed.slice();
    flipped[20] = flipped[20]! ^ 1;
    await expect(openPushSummary(open, ENVELOPE, flipped)).rejects.toThrow(code('decrypt_failed'));
    await expect(openPushSummary(open, ENVELOPE, sealed.subarray(0, 27))).rejects.toThrow(
      code('decrypt_failed'),
    );
    await expect(
      openPushSummary(open, ENVELOPE, new Uint8Array(MAX_PUSH_SUMMARY_BYTES + 1)),
    ).rejects.toThrow(code('decrypt_failed'));
  });

  it('seals at most 1 KiB and refuses a larger plaintext', async () => {
    const { seal, open } = await keys();
    const largest = new Uint8Array(MAX_PUSH_SUMMARY_PLAINTEXT_BYTES).fill(65);
    const sealed = await sealPushSummary(seal, ENVELOPE, largest, seededRandom(7));
    expect(sealed.length).toBe(MAX_PUSH_SUMMARY_BYTES);
    expect(await openPushSummary(open, ENVELOPE, sealed)).toEqual(largest);
    await expect(
      sealPushSummary(seal, ENVELOPE, new Uint8Array(largest.length + 1), seededRandom(7)),
    ).rejects.toThrow(code('invalid_argument'));
  });

  it('cannot be opened with an unrelated pairing key', async () => {
    const { seal } = await keys();
    const stranger = await deriveNotificationKey(
      (await staticKey(3)).privateKey,
      (await staticKey(2)).publicKey,
      ['decrypt'],
    );
    const sealed = await sealPushSummary(seal, ENVELOPE, utf8('x'), seededRandom(7));
    await expect(openPushSummary(stranger, ENVELOPE, sealed)).rejects.toThrow(
      code('decrypt_failed'),
    );
  });
});
