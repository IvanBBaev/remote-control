import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand/vanilla';

import { classifyFailure } from './ceremony.js';
import type { CeremonyFailure } from './ceremony.js';
import { OfflineError } from './relay-api.js';
import type { RelayApi } from './relay-api.js';

export type AuthStatus = 'unknown' | 'signed-out' | 'signed-in';

export type AuthResult =
  { readonly ok: true } | { readonly ok: false; readonly failure: CeremonyFailure };

export interface AuthState {
  readonly status: AuthStatus;
  readonly userId: string | null;
  /**
   * The recovery code from a fresh registration, held until the user confirms they
   * saved it. The relay never shows it again (D8), so onboarding waits for that tap.
   */
  readonly recoveryCode: string | null;
  /** Asks the relay whether the session cookie is still valid. */
  readonly checkSession: () => Promise<void>;
  /** Invite code → passkey with UV → session; leaves `recoveryCode` to confirm. */
  readonly register: (input: { inviteCode: string; displayName?: string }) => Promise<AuthResult>;
  /** Sign in from the button: the browser's passkey sheet. */
  readonly login: () => Promise<AuthResult>;
  /**
   * Sign in through conditional UI: resolves once the user picks the passkey from the
   * autofill list of the `autocomplete="username webauthn"` field (05 Rec-4).
   */
  readonly loginWithAutofill: () => Promise<AuthResult>;
  readonly confirmRecoverySaved: () => void;
  readonly signOut: () => Promise<void>;
}

export type AuthStore = StoreApi<AuthState>;

/**
 * Remembers who was signed in last, so an installed app that starts offline is not sent
 * back to the passkey step. It is a hint for the UI, not a credential: the relay checks
 * the session cookie on every call.
 */
export interface SessionHint {
  read(): string | null;
  write(userId: string | null): void;
}

const HINT_KEY = 'rc.auth.userId';

/** `localStorage` can be missing or throw (private mode, blocked site data). */
export function storageSessionHint(storage: () => Storage | undefined): SessionHint {
  return {
    read() {
      try {
        return storage()?.getItem(HINT_KEY) ?? null;
      } catch {
        return null;
      }
    },
    write(userId) {
      try {
        if (userId === null) storage()?.removeItem(HINT_KEY);
        else storage()?.setItem(HINT_KEY, userId);
      } catch {
        // A hint that cannot be stored only costs a sign-in after an offline start.
      }
    },
  };
}

export const noSessionHint: SessionHint = { read: () => null, write: () => undefined };

export interface AuthStoreOptions {
  readonly api: RelayApi;
  readonly hint?: SessionHint;
  readonly initial?: Partial<Pick<AuthState, 'status' | 'userId' | 'recoveryCode'>>;
}

/** Signed in and past the recovery-code confirmation: what the onboarding gate needs. */
export function isSignedIn(state: Pick<AuthState, 'status' | 'recoveryCode'>): boolean {
  return state.status === 'signed-in' && state.recoveryCode === null;
}

/** Passkey session state (D8): registration, login, recovery-code confirmation. */
export function createAuthStore({
  api,
  hint = noSessionHint,
  initial,
}: AuthStoreOptions): AuthStore {
  return createStore<AuthState>()((set) => {
    function signedIn(userId: string, recoveryCode: string | null = null): void {
      hint.write(userId);
      set({ status: 'signed-in', userId, recoveryCode });
    }

    function signedOut(): void {
      hint.write(null);
      set({ status: 'signed-out', userId: null, recoveryCode: null });
    }

    async function attempt(run: () => Promise<void>): Promise<AuthResult> {
      try {
        await run();
        return { ok: true };
      } catch (error) {
        return { ok: false, failure: classifyFailure(error) };
      }
    }

    async function authenticate(useBrowserAutofill: boolean): Promise<void> {
      const optionsJSON = await api.loginOptions();
      const response = await startAuthentication({ optionsJSON, useBrowserAutofill });
      const { userId } = await api.loginVerify(response);
      signedIn(userId);
    }

    return {
      status: 'unknown',
      userId: null,
      recoveryCode: null,
      ...initial,

      async checkSession() {
        try {
          const session = await api.session();
          if (session === null) signedOut();
          else signedIn(session.userId);
        } catch (error) {
          // Offline start: trust the hint until the relay answers. Any other failure
          // (5xx, rate limit) leaves the state as it is.
          if (!(error instanceof OfflineError)) return;
          const userId = hint.read();
          if (userId === null) set({ status: 'signed-out' });
          else set({ status: 'signed-in', userId });
        }
      },

      register: ({ inviteCode, displayName }) =>
        attempt(async () => {
          const optionsJSON = await api.registerOptions({
            inviteCode,
            ...(displayName === undefined ? {} : { displayName }),
          });
          const response = await startRegistration({ optionsJSON });
          const registered = await api.registerVerify(response);
          signedIn(registered.userId, registered.recoveryCode);
        }),

      login: () => attempt(() => authenticate(false)),
      loginWithAutofill: () => attempt(() => authenticate(true)),

      confirmRecoverySaved() {
        set({ recoveryCode: null });
      },

      async signOut() {
        try {
          await api.logout();
        } finally {
          signedOut();
        }
      },
    };
  });
}
