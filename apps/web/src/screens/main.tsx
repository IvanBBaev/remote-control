import type { ChangedFile, Session } from '@remote-control/protocol';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useStore } from 'zustand';

import { useAppState } from '../app-state.js';
import { presenceLabel } from '../realtime/realtime-store.js';
import type { RealtimeState } from '../realtime/realtime-store.js';
import { historySummary, machineUsage, usageSummary } from '../realtime/usage-stats.js';
import { Notice, Screen } from './layout.js';
import { ComposeBox } from './session-commands.js';

/**
 * Paired computers and their online state, from relay timestamps (M0-20), with this
 * computer's own history per repository (M2-06) and this phone's local counters per
 * computer and project (M1-11).
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
      <div className="actions">
        <Link className="button primary" to="/onboarding/pair">
          {machines.length === 0 ? 'Add your first computer' : 'Add a computer'}
        </Link>
      </div>
    </Screen>
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
 * session waits for.
 */
export function SessionsScreen() {
  const { phone } = useAppState();
  const machines = Object.values(useStore(phone.realtime, (state) => state.machines))
    .filter((machine) => machine.sessions.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <Screen title="Sessions">
      {machines.length === 0 ? (
        <Notice>No sessions yet. Start one here or run an agent on a paired computer.</Notice>
      ) : (
        machines.map((machine) => (
          <section key={machine.deviceId} className="session-group">
            <h2>{machine.name}</h2>
            <ul className="session-list">
              {machine.sessions.map((session) => (
                <li key={session.id}>
                  <Link to={`/sessions/${encodeURIComponent(session.id)}`}>
                    <span className="session-name">{sessionName(session)}</span>
                    <span className={`badge state-${session.state}`}>
                      {STATE_LABEL[session.state]}
                    </span>
                    <span className="meta">{session.statusText}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
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

/** A changed file: its name and `+N −M`; a tap shows the full path. No diff (D21). */
function ChangedFileItem({ file }: { readonly file: ChangedFile }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button type="button" className="link" aria-expanded={open} onClick={() => setOpen(!open)}>
        {baseName(file.name)}
      </button>{' '}
      <span className="added">+{file.added}</span> <span className="removed">−{file.removed}</span>
      {open && <code className="details">{file.name}</code>}
    </li>
  );
}

/**
 * One session (M1-05, D21): its state, the last prompt, the steps of this turn, the files
 * changed and the last answer, plus the follow-up compose box (M1-04). No diff bodies.
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
              <ChangedFileItem key={file.name} file={file} />
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
