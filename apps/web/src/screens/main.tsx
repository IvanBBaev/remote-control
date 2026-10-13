import { Link, useParams } from 'react-router';
import { useStore } from 'zustand';

import { useAppState } from '../app-state.js';
import { presenceLabel } from '../realtime/realtime-store.js';
import { historySummary, machineUsage, usageSummary } from '../realtime/usage-stats.js';
import { Notice, Screen } from './layout.js';

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
