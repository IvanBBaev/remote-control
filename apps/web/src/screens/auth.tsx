import { WebAuthnAbortService, browserSupportsWebAuthnAutofill } from '@simplewebauthn/browser';
import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';

import { useAppState, useAuth } from '../app-state.js';
import type { AuthResult } from '../auth/auth-store.js';
import type { CeremonyFailure } from '../auth/ceremony.js';
import { useOnline } from '../online.js';
import { Notice, Screen } from './layout.js';

/** Where a fresh sign-in continues: the gate picks the first unmet step, or home. */
const AFTER_SIGN_IN = '/onboarding';

const RATE_LIMITED = 'Too many attempts — wait a minute and try again.';

function registrationError(failure: CeremonyFailure): string {
  if (failure === 'offline') return 'You are offline — connect to create your passkey.';
  if (failure === 'rate_limited') return RATE_LIMITED;
  if (typeof failure === 'object' && failure.relay === 'invalid_invite') {
    return 'This invite code is not valid.';
  }
  return 'Passkey not created — try again.';
}

function loginError(failure: CeremonyFailure): string | null {
  // Dismissing the sheet is a choice, not an error: the screen stays as it was.
  if (failure === 'cancelled') return null;
  if (failure === 'offline') return 'You are offline — connect to sign in.';
  if (failure === 'rate_limited') return RATE_LIMITED;
  if (typeof failure === 'object' && failure.relay === 'unknown_credential') {
    return 'This passkey is not registered here — create an account.';
  }
  return 'Sign-in failed — try again.';
}

/**
 * Onboarding step 1: an invite code, then a passkey with user verification (D8, 05
 * Rec-4); it works in a plain browser tab. A fresh account shows its recovery code next.
 */
export function PasskeyScreen() {
  const recoveryCode = useAuth((s) => s.recoveryCode);
  return recoveryCode === null ? <CreatePasskey /> : <RecoveryCode code={recoveryCode} />;
}

function CreatePasskey() {
  const register = useAuth((s) => s.register);
  const online = useOnline();
  const [params] = useSearchParams();
  const [inviteCode, setInviteCode] = useState(params.get('invite') ?? '');
  const [displayName, setDisplayName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();

  // Submitting the form is the tap: the passkey sheet opens from this user gesture.
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    const name = displayName.trim();
    void register({ inviteCode: inviteCode.trim(), ...(name === '' ? {} : { displayName: name }) })
      .then((result: AuthResult) => {
        if (!result.ok) setError(registrationError(result.failure));
      })
      .finally(() => {
        setPending(false);
      });
  };

  return (
    <Screen title="Create your passkey">
      <p>
        Your passkey signs you in and approves every request. It stays on this phone and in your
        password manager.
      </p>
      {!online && <Notice>You are offline — connect to create your passkey.</Notice>}
      {error !== null && online && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <form className="passkey-form" onSubmit={onSubmit}>
        <label htmlFor={`${ids}-invite`}>Invite code</label>
        <input
          id={`${ids}-invite`}
          name="invite"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          required
          maxLength={64}
          value={inviteCode}
          onChange={(event) => {
            setInviteCode(event.target.value);
          }}
        />
        <label htmlFor={`${ids}-name`}>Your name (optional)</label>
        <input
          id={`${ids}-name`}
          name="displayName"
          autoComplete="name"
          maxLength={64}
          value={displayName}
          onChange={(event) => {
            setDisplayName(event.target.value);
          }}
        />
        <div className="actions">
          <button
            type="submit"
            className="primary"
            disabled={!online || pending || inviteCode.trim() === ''}
          >
            Create passkey
          </button>
          <Link className="button" to="/login">
            I already have an account
          </Link>
        </div>
      </form>
    </Screen>
  );
}

/** Shown once after registration; onboarding goes on only after "I saved it" (D8). */
function RecoveryCode({ code }: { code: string }) {
  const confirm = useAuth((s) => s.confirmRecoverySaved);
  const [saved, setSaved] = useState(false);
  const id = useId();
  return (
    <Screen title="Save your recovery code">
      <p>
        If you lose this passkey, this code is the only way back into your account. It is shown once
        — store it in your password manager.
      </p>
      <pre className="recovery-code" aria-label="Recovery code">
        {code}
      </pre>
      <label className="confirm" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={saved}
          onChange={(event) => {
            setSaved(event.target.checked);
          }}
        />
        I saved my recovery code somewhere safe
      </label>
      <div className="actions">
        <button type="button" className="primary" disabled={!saved} onClick={confirm}>
          Continue
        </button>
      </div>
    </Screen>
  );
}

/**
 * Sign in with an existing passkey: returning user, new device, or the installed iOS
 * app, which starts with its own storage. The username field offers the passkey in the
 * keyboard's autofill bar (conditional UI, 05 Rec-4); the button opens the sheet.
 */
export function LoginScreen() {
  const { auth } = useAppState();
  const navigate = useNavigate();
  const online = useOnline();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = (result: AuthResult) => {
    if (result.ok) {
      void navigate(AFTER_SIGN_IN, { replace: true });
      return;
    }
    setError(loginError(result.failure));
  };

  useEffect(() => {
    let active = true;
    void browserSupportsWebAuthnAutofill().then(async (supported) => {
      if (!supported || !active) return;
      const result = await auth.getState().loginWithAutofill();
      // A cancelled autofill ceremony is the button replacing it, or this screen leaving.
      if (active && (result.ok || result.failure !== 'cancelled')) finish(result);
    });
    return () => {
      active = false;
      WebAuthnAbortService.cancelCeremony();
    };
    // One ceremony per mount; `finish` only navigates or sets state.
  }, [auth]);

  const onSignIn = () => {
    setPending(true);
    setError(null);
    void auth
      .getState()
      .login()
      .then(finish)
      .finally(() => {
        setPending(false);
      });
  };

  return (
    <Screen title="Sign in">
      <p>Use the passkey you created for remote-control.</p>
      {!online && <Notice>You are offline — connect to sign in.</Notice>}
      {error !== null && online && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <form
        className="login-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSignIn();
        }}
      >
        <label htmlFor="login-username">Account</label>
        <input
          id="login-username"
          name="username"
          autoComplete="username webauthn"
          placeholder="Choose your passkey"
        />
        <div className="actions">
          <button type="submit" className="primary" disabled={!online || pending}>
            Sign in with passkey
          </button>
          <Link className="button" to="/onboarding/passkey">
            Create a new account
          </Link>
        </div>
      </form>
    </Screen>
  );
}
