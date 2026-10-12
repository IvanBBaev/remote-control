import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

import type { NewPasskey, StoredPasskey } from './account-store.js';

export type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
};

export interface RegistrationOptionsInput {
  readonly userId: Uint8Array;
  readonly userName: string;
  readonly challenge: Uint8Array;
  readonly excludeCredentialIds: readonly string[];
}

/**
 * WebAuthn ceremonies for one relying party (RP ID + origin from config). The
 * adapter wraps `@simplewebauthn/server`; every verification requires user
 * verification (D8). Verification failures resolve to `null`, never throw.
 */
export interface WebAuthnPort {
  registrationOptions(
    input: RegistrationOptionsInput,
  ): Promise<PublicKeyCredentialCreationOptionsJSON>;
  authenticationOptions(challenge: Uint8Array): Promise<PublicKeyCredentialRequestOptionsJSON>;
  /** The base64url challenge inside a response's `clientDataJSON`, or `null` if unreadable. */
  challengeOf(response: RegistrationResponseJSON | AuthenticationResponseJSON): string | null;
  verifyRegistration(
    response: RegistrationResponseJSON,
    expectedChallenge: string,
  ): Promise<NewPasskey | null>;
  verifyAuthentication(
    response: AuthenticationResponseJSON,
    expectedChallenge: string,
    passkey: StoredPasskey,
  ): Promise<{ readonly newCounter: number; readonly backedUp: boolean } | null>;
}
