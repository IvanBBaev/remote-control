import { vi } from 'vitest';

import type { RelayApi } from './relay-api.js';

const RELAY_METHODS = [
  'registerOptions',
  'registerVerify',
  'loginOptions',
  'loginVerify',
  'session',
  'logout',
  'decisionChallenge',
  'decisionVerify',
] as const satisfies readonly (keyof RelayApi)[];

/** A relay whose every call fails loudly unless the test stubs it. */
export function fakeRelay(overrides: Partial<RelayApi> = {}): RelayApi {
  const unstubbed = (name: string) => () => Promise.reject(new Error(`fakeRelay.${name}`));
  return {
    ...(Object.fromEntries(
      RELAY_METHODS.map((name) => [name, unstubbed(name)]),
    ) as unknown as RelayApi),
    ...overrides,
  };
}

const bytes = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer;

/** Base64url of the fake credential id `rawId` (`cred-1`). */
export const FAKE_CREDENTIAL_ID = 'Y3JlZC0x';

function attestation() {
  return {
    id: FAKE_CREDENTIAL_ID,
    rawId: bytes('cred-1'),
    type: 'public-key',
    authenticatorAttachment: 'platform',
    response: {
      clientDataJSON: bytes('{"type":"webauthn.create"}'),
      attestationObject: bytes('attestation'),
      getTransports: () => ['internal', 'hybrid'],
    },
    getClientExtensionResults: () => ({}),
  };
}

function assertion() {
  return {
    id: FAKE_CREDENTIAL_ID,
    rawId: bytes('cred-1'),
    type: 'public-key',
    authenticatorAttachment: 'platform',
    response: {
      clientDataJSON: bytes('{"type":"webauthn.get"}'),
      authenticatorData: bytes('auth-data'),
      signature: bytes('signature'),
      userHandle: bytes('user-1'),
    },
    getClientExtensionResults: () => ({}),
  };
}

export interface MockedCredentials {
  readonly create: ReturnType<
    typeof vi.fn<(options: CredentialCreationOptions) => Promise<unknown>>
  >;
  readonly get: ReturnType<typeof vi.fn<(options: CredentialRequestOptions) => Promise<unknown>>>;
  restore(): void;
}

/** The DOMException a platform raises when the user dismisses the passkey sheet. */
export const userCancelled = (): DOMException =>
  new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError');

/**
 * A mocked `navigator.credentials` (and `PublicKeyCredential`) for jsdom: `create` and
 * `get` resolve with a well-formed platform credential and record the options they got.
 */
export function mockCredentials({ conditional = true } = {}): MockedCredentials {
  const create = vi.fn((_options: CredentialCreationOptions) =>
    Promise.resolve<unknown>(attestation()),
  );
  const get = vi.fn((_options: CredentialRequestOptions) => Promise.resolve<unknown>(assertion()));
  class FakePublicKeyCredential {
    static isConditionalMediationAvailable = () => Promise.resolve(conditional);
  }
  vi.stubGlobal('PublicKeyCredential', FakePublicKeyCredential);
  Object.defineProperty(navigator, 'credentials', { value: { create, get }, configurable: true });
  return {
    create,
    get,
    restore() {
      vi.unstubAllGlobals();
      Reflect.deleteProperty(navigator, 'credentials');
    },
  };
}
