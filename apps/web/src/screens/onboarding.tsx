import { useState } from 'react';
import { Link } from 'react-router';

import { useAppState } from '../app-state.js';
import type { MissingCapability } from '../capabilities.js';
import { Notice, Screen } from './layout.js';

const CAPABILITY_LABELS: Readonly<Record<MissingCapability, string>> = {
  webAuthn: 'Passkeys (WebAuthn)',
  webCrypto: 'End-to-end encryption (WebCrypto X25519)',
  push: 'Push notifications',
};

/** Shown when the browser is below the platform floor (D3); there is no fallback. */
export function UpdateBrowserScreen() {
  const { capabilities } = useAppState().state;
  return (
    <Screen title="Update your browser">
      <p>This browser is missing features remote-control needs:</p>
      <ul className="missing">
        {capabilities.missing.map((capability) => (
          <li key={capability}>{CAPABILITY_LABELS[capability]}</li>
        ))}
      </ul>
      <p>
        Use Safari on iOS 17 or later, or Chrome 133 or later on Android, then open this page again.
      </p>
    </Screen>
  );
}

/** Step 1: create a passkey; it works in a plain browser tab. */
export function PasskeyScreen() {
  return (
    <Screen title="Create your passkey">
      <p>
        Your passkey signs you in and approves every request. It stays on this phone and in your
        password manager.
      </p>
      <div className="actions">
        <button type="button" className="primary" disabled>
          Create passkey
        </button>
        <Link className="button" to="/login">
          I already have an account
        </Link>
      </div>
    </Screen>
  );
}

/** Step 2: add to Home Screen. Required where push needs it (iOS), optional elsewhere. */
export function InstallScreen() {
  const { state, skipInstall } = useAppState();
  const required = state.capabilities.verdict === 'install-required';
  return (
    <Screen title="Install the app">
      {required ? (
        <p>Notifications only work once remote-control is on your Home Screen.</p>
      ) : (
        <p>Installing gives remote-control its own icon and a full-screen window.</p>
      )}
      <ol className="steps">
        <li>
          Tap <strong>Share</strong> in the browser toolbar.
        </li>
        <li>
          Choose <strong>Add to Home Screen</strong>.
        </li>
        <li>Open remote-control from your Home Screen and sign in again with your passkey.</li>
      </ol>
      {!required && (
        <div className="actions">
          <button type="button" onClick={skipInstall}>
            Continue in the browser
          </button>
        </div>
      )}
    </Screen>
  );
}

/** Step 3: notification permission. Must be requested from this tap (05 F1). */
export function NotificationsScreen() {
  const { state, requestNotifications } = useAppState();
  const [pending, setPending] = useState(false);
  const permission = state.notificationPermission;
  const onEnable = () => {
    setPending(true);
    void requestNotifications().finally(() => {
      setPending(false);
    });
  };
  return (
    <Screen title="Turn on notifications">
      <p>remote-control tells you when an agent needs an answer, even when the app is closed.</p>
      {permission === 'denied' && (
        <Notice>
          Notifications are blocked. Allow them for remote-control in your phone&apos;s settings,
          then come back.
        </Notice>
      )}
      {permission === 'unsupported' && (
        <Notice>This browser cannot show notifications. Install the app first.</Notice>
      )}
      <div className="actions">
        <button
          type="button"
          className="primary"
          onClick={onEnable}
          disabled={pending || permission === 'denied' || permission === 'unsupported'}
        >
          Enable notifications
        </button>
      </div>
    </Screen>
  );
}

/** Step 4: pair the first computer with the code `remotectl pair` prints. */
export function PairScreen() {
  const [code, setCode] = useState('');
  return (
    <Screen title="Add your first computer">
      <p>On your computer, run:</p>
      <pre className="command">npx remotectl pair</pre>
      <p>Then enter the code it shows, or scan its QR code with your camera.</p>
      <form
        className="pair-form"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <label htmlFor="pair-code">Pairing code</label>
        <input
          id="pair-code"
          name="code"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={12}
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
          }}
        />
        <button type="submit" className="primary" disabled>
          Pair
        </button>
      </form>
    </Screen>
  );
}
