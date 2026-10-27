import { fromHex } from '@remote-control/crypto';
import { decisionHash, toBase64Url, VERSION_TABLE } from '@remote-control/protocol';
import type { CanonicalDecision } from '@remote-control/protocol';
import { describe, expect, it } from 'vitest';

import {
  authorizeWithDeviceKey,
  deleteAccountWithoutPasskey,
  pairedDeviceKey,
  spkiFromRawP256,
  type DeviceSigner,
} from './authorize';

function decision(kind: CanonicalDecision['kind']): CanonicalDecision {
  return {
    v: VERSION_TABLE.v,
    kind,
    request_id: 'r-1',
    request_hash: 'a'.repeat(64),
    payload: null,
    issued_at: 1_800_000_000,
    expires_at: 1_800_000_060,
    phone_device_id: 'phone',
    agent_device_id: 'agent',
  };
}

const SIGNATURE = new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02]);

/** A signer that records what it was asked to sign and answers with `outcome`. */
function recordingSigner(outcome: () => Promise<Uint8Array | null>) {
  const calls: { message: Uint8Array; reason: string }[] = [];
  const signer: DeviceSigner = {
    publicKey: () => Promise.reject(new Error('unused')),
    sign: (message, reason) => {
      calls.push({ message, reason });
      return outcome();
    },
  };
  return { signer, calls };
}

async function webCryptoPoint(): Promise<{ raw: Uint8Array; spki: Uint8Array }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  return {
    raw: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
    spki: new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)),
  };
}

describe('spkiFromRawP256', () => {
  it('wraps the raw point exactly as WebCrypto exports the SPKI', async () => {
    const { raw, spki } = await webCryptoPoint();
    expect(spkiFromRawP256(raw)).toEqual(spki);
  });

  it('refuses anything but an uncompressed P-256 point', async () => {
    const { raw } = await webCryptoPoint();
    expect(() => spkiFromRawP256(raw.subarray(1))).toThrow('not an uncompressed P-256 point');
    expect(() => spkiFromRawP256(new Uint8Array(65).fill(2))).toThrow(
      'not an uncompressed P-256 point',
    );
  });
});

describe('pairedDeviceKey', () => {
  it('hands over the SPKI as base64url, user-verified', async () => {
    const { raw, spki } = await webCryptoPoint();
    const signer: DeviceSigner = {
      publicKey: () => Promise.resolve(raw),
      sign: () => Promise.resolve(null),
    };
    expect(await pairedDeviceKey(signer)).toEqual({
      publicKey: toBase64Url(spki),
      userVerified: true,
    });
  });

  it('pairs without a key when the phone cannot make one', async () => {
    const signer: DeviceSigner = {
      publicKey: () => Promise.reject(new Error('no biometry')),
      sign: () => Promise.resolve(null),
    };
    expect(await pairedDeviceKey(signer)).toBeUndefined();
  });
});

describe('authorizeWithDeviceKey', () => {
  it('sends a deny and a terminal release with their hash, unsigned', async () => {
    const { signer, calls } = recordingSigner(() => Promise.resolve(SIGNATURE));
    const authorize = authorizeWithDeviceKey(signer);
    for (const kind of ['deny', 'terminal'] as const) {
      expect(await authorize(decision(kind))).toEqual({
        ok: true,
        decisionHash: await decisionHash(decision(kind)),
        asserted: false,
      });
    }
    expect(calls).toEqual([]);
  });

  it.each([
    ['allow', 'Allow this request'],
    ['always', 'Always allow this tool'],
    ['answer', 'Send this answer'],
    ['instruct', 'Send this instruction'],
    ['start', 'Start this session'],
  ] as const)('signs the decision hash of a %s behind Face ID', async (kind, reason) => {
    const { signer, calls } = recordingSigner(() => Promise.resolve(SIGNATURE));
    const hash = await decisionHash(decision(kind));
    expect(await authorizeWithDeviceKey(signer)(decision(kind))).toEqual({
      ok: true,
      decisionHash: hash,
      asserted: true,
      deviceSignature: toBase64Url(SIGNATURE),
    });
    expect(calls).toEqual([{ message: fromHex(hash), reason }]);
  });

  it('reports a dismissed Face ID sheet as cancelled', async () => {
    const { signer } = recordingSigner(() => Promise.resolve(null));
    expect(await authorizeWithDeviceKey(signer)(decision('allow'))).toEqual({
      ok: false,
      failure: 'cancelled',
    });
  });

  it('reports a key that cannot sign (gone, or biometry changed) as failed', async () => {
    const { signer } = recordingSigner(() => Promise.reject(new Error('no key')));
    expect(await authorizeWithDeviceKey(signer)(decision('allow'))).toEqual({
      ok: false,
      failure: 'failed',
    });
  });
});

describe('deleteAccountWithoutPasskey', () => {
  it('refuses', async () => {
    expect(await deleteAccountWithoutPasskey()).toEqual({ ok: false, failure: 'cancelled' });
  });
});
