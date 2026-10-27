import type { DecisionAssertion } from '@remote-control/protocol';

/** Why a passkey ceremony or its relay round trip did not complete. */
export type CeremonyFailure =
  /** The user dismissed the sheet, or another ceremony replaced this one. */
  | 'cancelled'
  | 'offline'
  | 'rate_limited'
  /** The relay refused with this `{ error }` code. */
  | { readonly relay: string }
  | 'failed';

export type AssertDecisionResult =
  | {
      readonly ok: true;
      /** Goes into the head of the `cls: command` envelope (02 §5.4). */
      readonly decisionHash: string;
      /** `false` for Deny and "Reply in terminal": they need no assertion (D7). */
      readonly asserted: boolean;
      /**
       * The assertion itself, sealed into the decision so the agent checks it without
       * the relay (D7 phase 2, M2-03); absent when `asserted` is `false`.
       */
      readonly assertion?: DecisionAssertion;
      /**
       * The native app's device-key signature over the decision hash instead of an
       * assertion (ADR 0017, M4-04): only the agent checks it, so the envelope head then
       * carries no `decisionHash` for the relay.
       */
      readonly deviceSignature?: string;
    }
  | {
      readonly ok: false;
      readonly failure:
        | CeremonyFailure
        /** The relay's challenge is not this decision's hash: never sign it. */
        | 'challenge_mismatch';
    };

export type DeleteAccountResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: CeremonyFailure | 'challenge_mismatch' };
