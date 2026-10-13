import { HOOK_SEEN, NO_HOOK_SEEN, SETUP_CHECKLIST } from '@remote-control/protocol';
import type { ChangedFile, PairedDevice, Repository, Session } from '@remote-control/protocol';
import { useState } from 'react';
import { Link, NavLink, useParams } from 'react-router';
import { useStore } from 'zustand';

import { useAppState } from '../app-state.js';
import type { DeleteAccountResult } from '../auth/delete-account.js';
import { RelayError } from '../auth/relay-api.js';
import { presenceLabel } from '../realtime/realtime-store.js';
import type { MachineView, RealtimeState } from '../realtime/realtime-store.js';
import { historySummary, machineUsage, usageSummary } from '../realtime/usage-stats.js';
import { DiffView } from './diff-view.js';
import { Notice, Screen } from './layout.js';
import { ComposeBox } from './session-commands.js';
import { useWideLayout } from './split.js';

/**
 * Paired computers and their online state, from relay timestamps (M0-20), with this
 * computer's own history per repository (M2-06) and this phone's local counters per
 * computer and project (M1-11), its paired phones and hook status, and the "Can't
 * connect?" checklist in the wording `remotectl status` prints (M1-07). Phones are
 * revoked and the account deleted here (M1-10).
 */
export function MachinesScreen() {
  const { phone } = useAppState();
  const realtime = useStore(phone.realtime);
  const usage = useStore(phone.usage);
  const machines = Object.values(realtime.machines).sort((a, b) => a.name.localeCompare(b.name));
  const relayNow = phone.now() + realtime.relayOffset;
  return (
    <Screen title="Computers">
      {machines.length === 0 ? (
        <Notice>No computers yet.</Notice>
      ) : (
        <ul className="machine-list">
          {machines.map((machine) => {
            const presence = presenceLabel(machine, realtime, phone.now());
            const totals = machineUsage(usage, machine.deviceId);
            const projects = Object.entries(usage.machines[machine.deviceId] ?? {}).sort(
              ([a], [b]) => a.localeCompare(b),
            );
            return (
              <li key={machine.deviceId} className={presence.online ? 'online' : 'offline'}>
                <span className="machine-name">{machine.name}</span>
                <span className="meta">{presence.text}</span>
                {machine.history !== null && machine.history.length > 0 && (
                  <div className="machine-usage machine-history">
                    <p className="meta">On this computer:</p>
                    {machine.history.map((entry) => (
                      <p key={entry.project} className="meta project-usage">
                        <span className="project-name">{entry.project}</span>{' '}
                        {historySummary(entry, relayNow)}
                      </p>
                    ))}
                  </div>
                )}
                <MachineSetup machine={machine} />
                {totals !== undefined && (
                  <div className="machine-usage">
                    <p className="meta">From this phone: {usageSummary(totals)}</p>
                    {projects.map(([project, counts]) => (
                      <p key={project} className="meta project-usage">
                        <span className="project-name">{project}</span> {usageSummary(counts)}
                      </p>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <details className="setup-checklist">
        <summary>Can&apos;t connect?</summary>
        <ol>
          {SETUP_CHECKLIST.map((check) => (
            <li key={check.id}>
              <span className="check-question">{check.question}</span>{' '}
              <span className="meta">{check.fix}</span>
            </li>
          ))}
        </ol>
      </details>
      <div className="actions">
        <Link className="button primary" to="/onboarding/pair">
          {machines.length === 0 ? 'Add your first computer' : 'Add a computer'}
        </Link>
      </div>
      <DeleteAccount />
    </Screen>
  );
}

/** The day a phone was paired, as `YYYY-MM-DD` (UTC). */
const pairedDay = (device: PairedDevice) => new Date(device.pairedAt).toISOString().slice(0, 10);

/** Repositories whose hook status the computer reported. */
const hookStatus = (repositories: readonly Repository[]) =>
  repositories.filter((repository) => repository.hookSeen !== undefined);

/**
 * What a computer reported about its setup (M1-07): missing hooks, the hook status per
 * repository, and the paired phones, each with its revoke button (M1-10).
 */
function MachineSetup({ machine }: { machine: MachineView }) {
  const devices = machine.devices ?? [];
  const repositories = hookStatus(machine.repositories);
  const hooks = SETUP_CHECKLIST.find((check) => check.id === 'hooks')!;
  if (devices.length === 0 && repositories.length === 0 && machine.hooksInstalled !== false) {
    return null;
  }
  return (
    <div className="machine-setup">
      {machine.hooksInstalled === false && (
        <p className="meta hooks-missing">Claude Code hooks are not installed. {hooks.fix}</p>
      )}
      {repositories.map((repository) => (
        <p key={repository.id} className="meta repository-hooks">
          <span className="project-name">{repository.name}</span>{' '}
          {repository.hookSeen === true ? HOOK_SEEN : NO_HOOK_SEEN}
        </p>
      ))}
      {devices.length > 0 && (
        <ul className="paired-devices">
          {devices.map((device) => (
            <li key={device.id}>
              <span className="device-name">{device.name}</span>{' '}
              <span className="meta">paired {pairedDay(device)}</span>
              <RevokeDevice device={device} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type RevokeStep = 'idle' | 'confirm' | 'pending' | 'done' | 'failed';

/**
 * Revokes a paired phone at the relay after a second tap (M1-10): its sessions end and
 * every computer refuses it until it pairs again. The relay no longer knowing the phone
 * counts as done. The computer drops it from its list on its next report.
 */
function RevokeDevice({ device }: { device: PairedDevice }) {
  const { relay } = useAppState();
  const [step, setStep] = useState<RevokeStep>('idle');
  const revoke = async () => {
    setStep('pending');
    try {
      await relay.revokeDevice(device.id);
      setStep('done');
    } catch (error) {
      setStep(error instanceof RelayError && error.status === 404 ? 'done' : 'failed');
    }
  };
  if (step === 'done') return <span className="meta revoked">Revoked</span>;
  if (step === 'confirm' || step === 'pending') {
    return (
      <span className="confirm">
        <button
          type="button"
          className="button danger"
          disabled={step === 'pending'}
          onClick={() => void revoke()}
        >
          Revoke {device.name}
        </button>
        <button type="button" className="button" onClick={() => setStep('idle')}>
          Cancel
        </button>
      </span>
    );
  }
  return (
    <>
      <button type="button" className="button" onClick={() => setStep('confirm')}>
        Revoke
      </button>
      {step === 'failed' && <span className="notice error">Could not revoke. Try again.</span>}
    </>
  );
}

type DeleteFailure = Extract<DeleteAccountResult, { ok: false }>['failure'];

function deleteFailureText(failure: DeleteFailure): string {
  if (failure === 'cancelled') return 'Face ID was cancelled. Nothing was deleted.';
  if (failure === 'offline') return 'You are offline. Nothing was deleted.';
  if (failure === 'rate_limited') return 'Too many attempts. Wait a minute and try again.';
  return 'Could not delete the account. Nothing was deleted.';
}

/**
 * Deletes the account behind a passkey assertion (M1-10, 02 §5.9): the relay drops every
 * device, pairing and record of it, the phone forgets its computers and signs out.
 */
function DeleteAccount() {
  const { auth, phone } = useAppState();
  const userId = useStore(auth, (state) => state.userId);
  const [step, setStep] = useState<'idle' | 'confirm' | 'pending'>('idle');
  const [failure, setFailure] = useState<DeleteFailure>();
  const remove = async () => {
    if (userId === null) return;
    setStep('pending');
    setFailure(undefined);
    const result = await phone.deleteAccount(userId);
    if (result.ok) {
      await auth
        .getState()
        .signOut()
        .catch(() => undefined);
      return;
    }
    setFailure(result.failure);
    setStep('confirm');
  };
  return (
    <section className="delete-account">
      {step === 'idle' ? (
        <button type="button" className="button" onClick={() => setStep('confirm')}>
          Delete account
        </button>
      ) : (
        <>
          <p className="meta">
            This removes your account, every paired computer and phone, and their history from the
            relay. Computers stop reaching this phone at once.
          </p>
          <div className="actions">
            <button
              type="button"
              className="button danger"
              disabled={step === 'pending' || userId === null}
              onClick={() => void remove()}
            >
              Delete my account
            </button>
            <button
              type="button"
              className="button"
              disabled={step === 'pending'}
              onClick={() => {
                setStep('idle');
                setFailure(undefined);
              }}
            >
              Cancel
            </button>
          </div>
          {failure !== undefined && <p className="notice error">{deleteFailureText(failure)}</p>}
        </>
      )}
    </section>
  );
}

/** A session's name as the lists show it. */
const sessionName = (session: Session) => session.name ?? 'Session';

/** The badge of a session's state: "needs you" for a session waiting on the phone. */
const STATE_LABEL: Record<Session['state'], string> = {
  starting: 'Starting',
  working: 'Working',
  waiting: 'Needs you',
  idle: 'Idle',
  ended: 'Ended',
};

/**
 * Running and recent agent sessions, per computer (M1-05): the state badge and what the
 * session waits for. The open session is marked `aria-current` (M2-05).
 */
export function SessionList() {
  const { phone } = useAppState();
  const machines = Object.values(useStore(phone.realtime, (state) => state.machines))
    .filter((machine) => machine.sessions.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (machines.length === 0) {
    return <Notice>No sessions yet. Start one here or run an agent on a paired computer.</Notice>;
  }
  return machines.map((machine) => (
    <section key={machine.deviceId} className="session-group">
      <h2>{machine.name}</h2>
      <ul className="session-list">
        {machine.sessions.map((session) => (
          <li key={session.id}>
            <NavLink to={`/sessions/${encodeURIComponent(session.id)}`}>
              <span className="session-name">{sessionName(session)}</span>
              <span className={`badge state-${session.state}`}>{STATE_LABEL[session.state]}</span>
              <span className="meta">{session.statusText}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </section>
  ));
}

/**
 * The Sessions tab. On a wide screen the list is already in the left pane (M2-05), so the
 * right one only asks to pick a session.
 */
export function SessionsScreen() {
  if (useWideLayout()) {
    return (
      <Screen title="Sessions">
        <Notice>Pick a session on the left, or start a new one.</Notice>
      </Screen>
    );
  }
  return (
    <Screen title="Sessions">
      <SessionList />
      <div className="actions">
        <Link className="button primary" to="/new">
          New session
        </Link>
      </div>
    </Screen>
  );
}

/** The session with `id` and the computer it runs on, from the latest snapshots. */
const findSession = (machines: RealtimeState['machines'], id: string) => {
  for (const machine of Object.values(machines)) {
    const session = machine.sessions.find((candidate) => candidate.id === id);
    if (session !== undefined) return { machineId: machine.deviceId, session };
  }
  return undefined;
};

/** The file name of a path (D21: the full path only on a tap). */
export const baseName = (path: string): string => path.split(/[\\/]/).at(-1) || path;

/**
 * A changed file: its name and `+N −M`; a tap shows the full path and fetches the diff
 * on demand (D21, M2-02).
 */
function ChangedFileItem(props: {
  readonly machineId: string;
  readonly sessionId: string;
  readonly file: ChangedFile;
}) {
  const { machineId, sessionId, file } = props;
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button type="button" className="link" aria-expanded={open} onClick={() => setOpen(!open)}>
        {baseName(file.name)}
      </button>{' '}
      <span className="added">+{file.added}</span> <span className="removed">−{file.removed}</span>
      {open && <code className="details">{file.name}</code>}
      {open && <DiffView machineId={machineId} sessionId={sessionId} file={file.name} />}
    </li>
  );
}

/**
 * One session (M1-05, D21): its state, the last prompt, the steps of this turn, the files
 * changed and the last answer, plus the follow-up compose box (M1-04). Diffs only on a tap.
 */
export function SessionScreen() {
  const { id = '' } = useParams();
  const { phone } = useAppState();
  const found = findSession(
    useStore(phone.realtime, (state) => state.machines),
    id,
  );
  const connected = useStore(phone.realtime, (state) => state.connection === 'open');
  if (found === undefined) {
    return (
      <Screen title="Session" back="/sessions">
        <Notice>{connected ? 'This session no longer exists.' : 'Connecting…'}</Notice>
      </Screen>
    );
  }
  const { machineId, session } = found;
  const empty =
    session.lastPrompt === null &&
    session.lastAnswer === null &&
    session.steps.length === 0 &&
    session.changedFiles.length === 0;
  return (
    <Screen title={sessionName(session)} back="/sessions">
      <p className="meta">
        {session.state} · {session.statusText}
      </p>
      {empty && <Notice>Nothing has happened in this session yet.</Notice>}
      {session.lastPrompt !== null && (
        <div className="session-part">
          <h2>Prompt</h2>
          <p className="session-text">{session.lastPrompt}</p>
        </div>
      )}
      {session.steps.length > 0 && (
        <div className="session-part">
          <h2>Steps</h2>
          <ol className="session-steps">
            {session.steps.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ol>
        </div>
      )}
      {session.changedFiles.length > 0 && (
        <div className="session-part">
          <h2>Changed files</h2>
          <ul className="changed-files">
            {session.changedFiles.map((file) => (
              <ChangedFileItem
                key={file.name}
                machineId={machineId}
                sessionId={session.id}
                file={file}
              />
            ))}
          </ul>
        </div>
      )}
      {session.lastAnswer !== null && (
        <div className="session-part">
          <h2>Answer</h2>
          <p className="session-text">{session.lastAnswer}</p>
        </div>
      )}
      <ComposeBox key={session.id} machineId={machineId} session={session} />
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
