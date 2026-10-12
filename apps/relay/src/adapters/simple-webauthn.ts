import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { decodeClientDataJSON } from '@simplewebauthn/server/helpers';

import type { WebAuthnPort } from '../ports/webauthn.js';

export interface RelyingParty {
  /** RP ID (`RC_RP_ID`): the relay's domain. */
  readonly id: string;
  /** The exact origin the PWA is served from (`RC_ORIGIN`). */
  readonly origin: string;
  readonly name: string;
}

/** ES256 only: what platform authenticators use and what the D7 SPKI plan expects. */
const ALGORITHMS = [-7];
const TIMEOUT_MS = 300_000;

/**
 * `@simplewebauthn/server` behind the WebAuthn port. Discoverable credentials and user
 * verification are required (D8); attestation is `none` (we trust the platform, not a
 * vendor list). Verification errors become `null` — the caller logs a reason code,
 * never the library's message or any WebAuthn material (D19).
 */
export function createSimpleWebAuthn(rp: RelyingParty): WebAuthnPort {
  return {
    registrationOptions: (input) =>
      generateRegistrationOptions({
        rpName: rp.name,
        rpID: rp.id,
        userID: Uint8Array.from(input.userId),
        userName: input.userName,
        challenge: Uint8Array.from(input.challenge),
        timeout: TIMEOUT_MS,
        attestationType: 'none',
        excludeCredentials: input.excludeCredentialIds.map((id) => ({ id })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        supportedAlgorithmIDs: ALGORITHMS,
      }),

    authenticationOptions: (challenge) =>
      generateAuthenticationOptions({
        rpID: rp.id,
        // Empty: discoverable credentials, the browser offers them (conditional UI).
        allowCredentials: [],
        challenge: Uint8Array.from(challenge),
        timeout: TIMEOUT_MS,
        userVerification: 'required',
      }),

    challengeOf(response) {
      try {
        const { challenge } = decodeClientDataJSON(response.response.clientDataJSON);
        return typeof challenge === 'string' ? challenge : null;
      } catch {
        return null;
      }
    },

    async verifyRegistration(response, expectedChallenge) {
      try {
        const result = await verifyRegistrationResponse({
          response,
          expectedChallenge,
          expectedOrigin: rp.origin,
          expectedRPID: rp.id,
          requireUserVerification: true,
          supportedAlgorithmIDs: ALGORITHMS,
        });
        if (!result.verified) return null;
        const info = result.registrationInfo;
        return {
          id: info.credential.id,
          publicKey: info.credential.publicKey,
          counter: info.credential.counter,
          transports: info.credential.transports,
          deviceType: info.credentialDeviceType,
          backedUp: info.credentialBackedUp,
        };
      } catch {
        return null;
      }
    },

    async verifyAuthentication(response, expectedChallenge, passkey) {
      try {
        const result = await verifyAuthenticationResponse({
          response,
          expectedChallenge,
          expectedOrigin: rp.origin,
          expectedRPID: rp.id,
          requireUserVerification: true,
          credential: {
            id: passkey.id,
            publicKey: Uint8Array.from(passkey.publicKey),
            counter: passkey.counter,
            ...(passkey.transports === undefined
              ? {}
              : { transports: [...passkey.transports] as never }),
          },
        });
        if (!result.verified) return null;
        return {
          newCounter: result.authenticationInfo.newCounter,
          backedUp: result.authenticationInfo.credentialBackedUp,
        };
      } catch {
        return null;
      }
    },
  };
}
