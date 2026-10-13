import { concatBytes, sha256, utf8 } from '@remote-control/crypto';
import { toBase64Url } from '@remote-control/protocol';

import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '../ports/webauthn.js';
import { encodeCbor } from './cbor.js';

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

/** Node's WebCrypto key pair (the relay compiles without the DOM lib). */
type KeyPair = Extract<
  Awaited<ReturnType<typeof crypto.subtle.generateKey>>,
  { privateKey: unknown }
>;

interface Credential {
  readonly id: Uint8Array;
  readonly keys: KeyPair;
  readonly userHandle: string;
  signCount: number;
}

/** Per-ceremony deviations for negative tests. */
export interface CeremonyOverrides {
  /** `clientDataJSON.origin` (default: the authenticator's origin). */
  readonly origin?: string;
  /** Sets the UV flag (default `true`). */
  readonly userVerified?: boolean;
  /** Replaces the challenge taken from the options. */
  readonly challenge?: string;
  /** Replaces the returned user handle (login only). */
  readonly userHandle?: string;
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
 * A platform authenticator in software for integration tests (M0-09 AC): ES256 keys in
 * WebCrypto, `none` attestation, discoverable credentials, and real authenticator data
 * and signatures, so `@simplewebauthn/server` verifies its output for real. Credential
 * ids are deterministic (instance number + counter, unique within a test process), keeping
 * the code free of ad-hoc randomness.
 */
export class SoftwareAuthenticator {
  static #instances = 0;
  readonly #instance = ++SoftwareAuthenticator.#instances;
  readonly #credentials: Credential[] = [];
  #nextId = 1;

  constructor(
    readonly rpId: string,
    readonly origin: string,
    /** Report the credential as synced (BE + BS flags). */
    private readonly backedUp = true,
  ) {}

  get credentialCount(): number {
    return this.#credentials.length;
  }

  /** `navigator.credentials.create()` for the given options. */
  async create(
    options: PublicKeyCredentialCreationOptionsJSON,
    overrides: CeremonyOverrides = {},
  ): Promise<RegistrationResponseJSON> {
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const id = new Uint8Array(16);
    new DataView(id.buffer).setUint32(0, this.#instance);
    new DataView(id.buffer).setUint32(12, this.#nextId++);
    const credential: Credential = { id, keys, userHandle: options.user.id, signCount: 0 };
    this.#credentials.push(credential);

    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
    const coseKey = encodeCbor(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, raw.subarray(1, 33)],
        [-3, raw.subarray(33, 65)],
      ]),
    );
    const attested = concatBytes(new Uint8Array(16), Uint8Array.from([0, id.length]), id, coseKey);
    const authData = await this.#authData(FLAG_AT, overrides, 0, attested);
    const clientDataJSON = this.#clientData('webauthn.create', options.challenge, overrides);
    const attestationObject = encodeCbor({ fmt: 'none', attStmt: {}, authData });
    return {
      id: toBase64Url(id),
      rawId: toBase64Url(id),
      type: 'public-key',
      response: {
        clientDataJSON: toBase64Url(clientDataJSON),
        attestationObject: toBase64Url(attestationObject),
        authenticatorData: toBase64Url(authData),
        // What `getPublicKey()` gives a browser: SPKI, so the phone can hand it to its
        // agents at pairing (D7 phase 2, M2-03).
        publicKey: toBase64Url(
          new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey)),
        ),
        publicKeyAlgorithm: -7,
        transports: ['internal'],
      },
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
    };
  }

  /** `navigator.credentials.get()` with the newest credential (or the one in `credentialId`). */
  async get(
    options: PublicKeyCredentialRequestOptionsJSON,
    overrides: CeremonyOverrides & { readonly credentialId?: string } = {},
  ): Promise<AuthenticationResponseJSON> {
    const credential =
      overrides.credentialId === undefined
        ? this.#credentials.at(-1)
        : this.#credentials.find((entry) => toBase64Url(entry.id) === overrides.credentialId);
    if (credential === undefined) throw new Error('no credential');
    credential.signCount += 1;
    const authData = await this.#authData(0, overrides, credential.signCount);
    const clientDataJSON = this.#clientData('webauthn.get', options.challenge, overrides);
    const signed = concatBytes(authData, await sha256(clientDataJSON));
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        credential.keys.privateKey,
        Uint8Array.from(signed),
      ),
    );
    return {
      id: toBase64Url(credential.id),
      rawId: toBase64Url(credential.id),
      type: 'public-key',
      response: {
        clientDataJSON: toBase64Url(clientDataJSON),
        authenticatorData: toBase64Url(authData),
        signature: toBase64Url(rawToDer(signature)),
        userHandle: overrides.userHandle ?? credential.userHandle,
      },
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
    };
  }

  async #authData(
    extraFlags: number,
    overrides: CeremonyOverrides,
    signCount: number,
    attested: Uint8Array = new Uint8Array(0),
  ): Promise<Uint8Array> {
    let flags = FLAG_UP | extraFlags;
    if (overrides.userVerified ?? true) flags |= FLAG_UV;
    if (this.backedUp) flags |= FLAG_BE | FLAG_BS;
    const counter = new Uint8Array(4);
    new DataView(counter.buffer).setUint32(0, signCount);
    return concatBytes(await sha256(utf8(this.rpId)), Uint8Array.from([flags]), counter, attested);
  }

  #clientData(type: string, challenge: string, overrides: CeremonyOverrides): Uint8Array {
    return utf8(
      JSON.stringify({
        type,
        challenge: overrides.challenge ?? challenge,
        origin: overrides.origin ?? this.origin,
        crossOrigin: false,
      }),
    );
  }
}
