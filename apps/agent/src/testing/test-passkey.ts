import { concatBytes, sha256, utf8 } from '@remote-control/crypto';
import {
  decisionChallenge,
  toBase64Url,
  type CanonicalDecision,
  type DecisionAssertion,
  type PairedPasskey,
} from '@remote-control/protocol';

/** Relying party id the fake phone's passkey is scoped to. */
export const TEST_RP_ID = 'rc.test';

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;

/** Per-assertion deviations for tamper tests. */
export interface AssertionOverrides {
  /** Sets the UV flag (default `true`). */
  readonly userVerified?: boolean;
  /** `clientDataJSON.type` (default `webauthn.get`). */
  readonly type?: string;
  /** `clientDataJSON.challenge` (default: the decision's challenge). */
  readonly challenge?: string;
  /** The relying party id hashed into `authenticatorData` (default: the passkey's). */
  readonly rpId?: string;
  /** The signature counter (default: one more than the last). */
  readonly counter?: number;
}

/** WebCrypto ECDSA gives `r || s`; WebAuthn signatures are DER `SEQUENCE { r, s }`. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array): number[] => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    const trimmed = [...bytes.subarray(start)];
    if (trimmed[0]! & 0x80) trimmed.unshift(0);
    return [0x02, trimmed.length, ...trimmed];
  };
  const body = [...integer(raw.subarray(0, 32)), ...integer(raw.subarray(32))];
  return Uint8Array.from([0x30, body.length, ...body]);
}

/**
 * A passkey in software for agent tests (M2-03): a WebCrypto ES256 key, real
 * authenticator data and real signatures over `authenticatorData || SHA-256(clientDataJSON)`,
 * so the agent's own assertion check runs for real.
 */
export interface TestPasskey {
  /** What the phone hands the agent at pairing. */
  readonly paired: PairedPasskey;
  assert(decision: CanonicalDecision, overrides?: AssertionOverrides): Promise<DecisionAssertion>;
}

let instances = 0;

export async function createTestPasskey(rpId = TEST_RP_ID): Promise<TestPasskey> {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
  const id = new Uint8Array(16);
  new DataView(id.buffer).setUint32(0, ++instances);
  const paired: PairedPasskey = { id: toBase64Url(id), publicKey: toBase64Url(spki), rpId };
  let counter = 0;
  return {
    paired,
    async assert(decision, overrides = {}) {
      counter = overrides.counter ?? counter + 1;
      const flags = FLAG_UP | (overrides.userVerified === false ? 0 : FLAG_UV);
      const count = new Uint8Array(4);
      new DataView(count.buffer).setUint32(0, counter);
      const authData = concatBytes(
        await sha256(utf8(overrides.rpId ?? rpId)),
        Uint8Array.of(flags),
        count,
      );
      const clientDataJSON = utf8(
        JSON.stringify({
          type: overrides.type ?? 'webauthn.get',
          challenge: overrides.challenge ?? (await decisionChallenge(decision)),
          origin: `https://${rpId}`,
          crossOrigin: false,
        }),
      );
      const signed = concatBytes(authData, await sha256(clientDataJSON));
      const raw = new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          keys.privateKey,
          Uint8Array.from(signed),
        ),
      );
      return {
        credentialId: paired.id,
        authenticatorData: toBase64Url(authData),
        clientDataJSON: toBase64Url(clientDataJSON),
        signature: toBase64Url(rawToDer(raw)),
      };
    },
  };
}
