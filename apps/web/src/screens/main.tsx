import { Link, useParams } from 'react-router';

import { Notice, Screen } from './layout.js';

/** Sign in with an existing passkey (returning user, new device or installed iOS app). */
export function LoginScreen() {
  return (
    <Screen title="Sign in">
      <p>Use the passkey you created for remote-control.</p>
      <div className="actions">
        <button type="button" className="primary" disabled>
          Sign in with passkey
        </button>
        <Link className="button" to="/onboarding/passkey">
          Create a new account
        </Link>
      </div>
    </Screen>
  );
}

/** Paired computers and their online state. */
export function MachinesScreen() {
  return (
    <Screen title="Computers">
      <Notice>No computers yet.</Notice>
      <div className="actions">
        <Link className="button primary" to="/onboarding/pair">
          Add your first computer
        </Link>
      </div>
    </Screen>
  );
}

/** Running and recent agent sessions across all computers. */
export function SessionsScreen() {
  return (
    <Screen title="Sessions">
      <Notice>No sessions yet. Start one here or run an agent on a paired computer.</Notice>
      <div className="actions">
        <Link className="button primary" to="/new">
          New session
        </Link>
      </div>
    </Screen>
  );
}

/** One session: transcript and the compose box. */
export function SessionScreen() {
  const { id = '' } = useParams();
  return (
    <Screen title="Session" back="/sessions">
      <p className="meta">
        Session <code>{id}</code>
      </p>
      <Notice>Loading the transcript…</Notice>
      <form
        className="compose"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <label htmlFor="compose-text">Message</label>
        <textarea id="compose-text" name="text" rows={3} disabled />
        <button type="submit" className="primary" disabled>
          Send
        </button>
      </form>
    </Screen>
  );
}

/** One approval request: what the agent wants to do, and Allow / Deny. */
export function RequestScreen() {
  const { id = '' } = useParams();
  return (
    <Screen title="Approval request" back="/sessions">
      <p className="meta">
        Request <code>{id}</code>
      </p>
      <Notice>Loading the request…</Notice>
      <div className="actions split">
        <button type="button" className="danger" disabled>
          Deny
        </button>
        <button type="button" className="primary" disabled>
          Allow
        </button>
      </div>
    </Screen>
  );
}

/** Start a new agent session on a paired computer. */
export function NewSessionScreen() {
  return (
    <Screen title="New session" back="/sessions">
      <form
        className="new-session"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <label htmlFor="new-machine">Computer</label>
        <select id="new-machine" name="machine" disabled>
          <option>No computers paired</option>
        </select>
        <label htmlFor="new-prompt">Prompt</label>
        <textarea id="new-prompt" name="prompt" rows={4} disabled />
        <button type="submit" className="primary" disabled>
          Start
        </button>
      </form>
    </Screen>
  );
}

export function NotFoundScreen() {
  return (
    <Screen title="Page not found">
      <p>This page does not exist.</p>
      <div className="actions">
        <Link className="button primary" to="/">
          Go home
        </Link>
      </div>
    </Screen>
  );
}
