import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router';

import { useAppState } from '../app-state.js';
import { useOnline } from '../online.js';
import { formatPairingCode, normalizePairingCode } from '../pairing/pairing-code.js';
import { PairingError } from '../realtime/phone.js';
import type { PendingPairing } from '../realtime/phone.js';
import { Notice, Screen } from './layout.js';

function ErrorNotice({ message }: { readonly message: string | undefined }) {
  if (message === undefined) return null;
  return (
    <p className="notice error" role="alert">
      {message}
    </p>
  );
}

/** Step 1: the one-time `remotectl login` command for a computer not signed in yet. */
function EnrolComputer({ online }: { readonly online: boolean }) {
  const { phone } = useAppState();
  const [name, setName] = useState('');
  const [token, setToken] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    phone
      .enroll(name.trim())
      .then(
        (enrolled) => {
          setToken(enrolled.enrollToken);
        },
        () => {
          setError('Could not create the login command. Try again.');
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <section className="pair-step" aria-labelledby="enrol-title">
      <h2 id="enrol-title">1. Sign the computer in</h2>
      {token === undefined ? (
        <form className="enrol-form" onSubmit={onSubmit}>
          <p>Skip this step if the computer is already signed in.</p>
          <label htmlFor="enrol-name">Computer name</label>
          <input
            id="enrol-name"
            name="name"
            maxLength={64}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <ErrorNotice message={error} />
          <button type="submit" disabled={!online || busy || name.trim() === ''}>
            Get the login command
          </button>
        </form>
      ) : (
        <>
          <p>On the computer, run once:</p>
          <pre className="command">npx remotectl login {token}</pre>
        </>
      )}
    </section>
  );
}

/** Step 2: the code `remotectl pair` prints; joining the slot runs the handshake. */
function EnterCode({
  online,
  onPaired,
}: {
  readonly online: boolean;
  readonly onPaired: (pending: PendingPairing) => void;
}) {
  const { phone } = useAppState();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    phone.pair(code).then(onPaired, (failure: unknown) => {
      setBusy(false);
      setError(failure instanceof PairingError ? failure.message : 'Pairing failed. Try again.');
    });
  };
  return (
    <section className="pair-step" aria-labelledby="pair-title">
      <h2 id="pair-title">2. Pair it</h2>
      <p>On the computer, run:</p>
      <pre className="command">npx remotectl pair</pre>
      <p>Then enter the code it shows.</p>
      <form className="pair-form" onSubmit={onSubmit}>
        <label htmlFor="pair-code">Pairing code</label>
        <input
          id="pair-code"
          name="code"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="XXXX-XXXX-XXXX"
          value={code}
          onChange={(event) => {
            setCode(formatPairingCode(event.target.value));
          }}
        />
        {busy && <Notice>Waiting for your computer…</Notice>}
        <ErrorNotice message={error} />
        <button
          type="submit"
          className="primary"
          disabled={!online || busy || normalizePairingCode(code) === undefined}
        >
          Pair
        </button>
      </form>
    </section>
  );
}

/** Both screens show the same fingerprint; only the user can tell they match (D6). */
function ConfirmPairing({
  pending,
  onConfirmed,
  onCancel,
}: {
  readonly pending: PendingPairing;
  readonly onConfirmed: () => void;
  readonly onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const onConfirm = () => {
    setBusy(true);
    setError(undefined);
    pending.confirm().then(onConfirmed, () => {
      setBusy(false);
      setError('Could not save the pairing on this phone. Try again.');
    });
  };
  return (
    <Screen title="Check the code">
      <p>
        <strong>{pending.name}</strong> shows a code in its terminal. Pair only if it is the same:
      </p>
      <p className="fingerprint" aria-label="Pairing fingerprint">
        {pending.fingerprint}
      </p>
      <ErrorNotice message={error} />
      <div className="actions split">
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={onConfirm} disabled={busy}>
          The codes match
        </button>
      </div>
    </Screen>
  );
}

/** Onboarding step 4, and "Add a computer" afterwards (M0-20). */
export function PairScreen() {
  const { state } = useAppState();
  const online = useOnline();
  const navigate = useNavigate();
  const [pending, setPending] = useState<PendingPairing>();
  const [cancelled, setCancelled] = useState(false);
  if (pending !== undefined) {
    return (
      <ConfirmPairing
        pending={pending}
        onConfirmed={() => {
          void navigate('/machines');
        }}
        onCancel={() => {
          setPending(undefined);
          setCancelled(true);
        }}
      />
    );
  }
  return (
    <Screen
      title={state.paired ? 'Add a computer' : 'Add your first computer'}
      {...(state.paired && { back: '/machines' })}
    >
      {!online && <Notice>You are offline — pairing needs a connection.</Notice>}
      {cancelled && (
        <Notice>Pairing cancelled. Run `npx remotectl pair` again to get a new code.</Notice>
      )}
      <EnrolComputer online={online} />
      <EnterCode
        online={online}
        onPaired={(next) => {
          setCancelled(false);
          setPending(next);
        }}
      />
    </Screen>
  );
}
