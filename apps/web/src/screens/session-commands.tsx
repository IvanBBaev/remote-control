import { permissionModesUpTo } from '@remote-control/protocol';
import type { PermissionMode, Repository, Session } from '@remote-control/protocol';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import { useStore } from 'zustand';

import { useAppState } from '../app-state.js';
import type { CommandResult } from '../realtime/phone.js';
import type { CommandView, MachineView } from '../realtime/realtime-store.js';
import { Notice, Screen } from './layout.js';
import { commandText, failureText } from './request-status.js';
import type { Failure } from './request-status.js';

/** The longest prompt the protocol carries (`StartSession.prompt`, `Instruction.text`). */
export const MAX_PROMPT_LENGTH = 16_384;

/** What each permission mode lets the started session do (M2-09, 04 §5.4). */
export const PERMISSION_MODE_LABELS: Readonly<Record<PermissionMode, string>> = {
  plan: 'Plan only (no edits)',
  default: 'Ask before each edit',
  acceptEdits: 'Accept file edits',
};

/** A computer the phone can send to right now: online with an open session. */
const reachable = (machine: MachineView | undefined): boolean =>
  machine?.online === true && machine.session === 'open';

/**
 * Sends one start or instruction and follows it in the store: the passkey sheet first
 * (D7), then "waiting" until the agent's `decision_result` or the relay's error.
 */
function useCommand() {
  const { phone } = useAppState();
  const [requestId, setRequestId] = useState<string>();
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<Failure>();
  const busy = useRef(false);
  const view = useStore(phone.realtime, (state) =>
    requestId === undefined ? undefined : state.commands[requestId],
  );

  const run = async (send: () => Promise<CommandResult>): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    setSending(true);
    setFailure(undefined);
    const result = await send();
    busy.current = false;
    setSending(false);
    if (result.ok) setRequestId(result.requestId);
    else setFailure(result.failure);
  };

  const status = view === undefined ? undefined : commandText(view);
  /** Sent and not yet answered: a second tap would start a second session. */
  const waiting = view !== undefined && status === undefined;
  return { run, view, status, waiting, sending, failure };
}

function CommandStatus({
  view,
  status,
  waiting,
  failure,
}: {
  readonly view: CommandView | undefined;
  readonly status: string | undefined;
  readonly waiting: boolean;
  readonly failure: Failure | undefined;
}) {
  const sessionId = view?.result?.result === 'accepted' ? view.result.sessionId : undefined;
  return (
    <>
      {failure !== undefined && <p className="notice error">{failureText(failure)}</p>}
      {waiting && <Notice>Sent. Waiting for your computer…</Notice>}
      {status !== undefined && (
        <p className={`notice${view?.result?.result === 'accepted' ? '' : ' error'}`}>{status}</p>
      )}
      {sessionId !== undefined && (
        <div className="actions">
          <Link className="button primary" to={`/sessions/${encodeURIComponent(sessionId)}`}>
            Open the session
          </Link>
        </div>
      )}
    </>
  );
}

/** The repository's folder name; its full path only after a tap (01 §5.3, 04 §5.4). */
function RepositoryChoice({
  repository,
  checked,
  onPick,
}: {
  readonly repository: Repository;
  readonly checked: boolean;
  readonly onPick: () => void;
}) {
  const [path, setPath] = useState(false);
  return (
    <li>
      <label>
        <input type="radio" name="repository" checked={checked} onChange={onPick} />{' '}
        <span className="project-name">{repository.name}</span>
      </label>{' '}
      <button
        type="button"
        className="link"
        aria-expanded={path}
        aria-label={`${path ? 'Hide' : 'Show'} the path of ${repository.name}`}
        onClick={() => setPath((shown) => !shown)}
      >
        {path ? 'Hide path' : 'Show path'}
      </button>
      {path && <code className="details">{repository.path}</code>}
    </li>
  );
}

/**
 * Start a session on a paired computer (M1-04): pick the computer, one of its
 * allow-listed repositories (the phone only picks, never edits the list), and the
 * prompt. Start asks for the passkey (D7); the computer still refuses a repository that
 * is not on its list, before anything runs.
 */
export function NewSessionScreen() {
  const { phone } = useAppState();
  const machines = useStore(phone.realtime, (state) => state.machines);
  const sorted = Object.values(machines).sort((a, b) => a.name.localeCompare(b.name));
  const [machineId, setMachineId] = useState<string>();
  const [repositoryId, setRepositoryId] = useState<string>();
  const [prompt, setPrompt] = useState('');
  const [picked, setPicked] = useState<PermissionMode>('default');
  const command = useCommand();

  if (sorted.length === 0) {
    return (
      <Screen title="New session" back="/sessions">
        <Notice>Pair a computer first.</Notice>
        <div className="actions">
          <Link className="button primary" to="/onboarding/pair">
            Add a computer
          </Link>
        </div>
      </Screen>
    );
  }

  const machine =
    (machineId === undefined ? undefined : machines[machineId]) ??
    sorted.find(reachable) ??
    sorted[0]!;
  const repositories = machine.repositories;
  const repository =
    repositories.find((candidate) => candidate.id === repositoryId) ?? repositories[0];
  // The computer's config bounds the mode per folder; an agent before M2-09 sends no
  // bound and gets no mode. The pick falls back to the default, or to the only mode a
  // `plan`-bound folder allows.
  const bound = repository?.maxPermissionMode;
  const modes = bound === undefined ? [] : permissionModesUpTo(bound);
  const permissionMode = modes.includes(picked)
    ? picked
    : modes.includes('default') || modes.length === 0
      ? 'default'
      : modes[modes.length - 1]!;
  const online = reachable(machine);
  const text = prompt.trim();
  const canStart =
    online && repository !== undefined && text.length > 0 && !command.sending && !command.waiting;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canStart) return;
    void command.run(() => phone.start(machine.deviceId, repository, text, permissionMode));
  };

  return (
    <Screen title="New session" back="/sessions">
      <form className="new-session" onSubmit={submit}>
        <label htmlFor="new-machine">Computer</label>
        <select
          id="new-machine"
          name="machine"
          value={machine.deviceId}
          onChange={(event) => {
            setMachineId(event.target.value);
            setRepositoryId(undefined);
            setPicked('default');
          }}
        >
          {sorted.map((candidate) => (
            <option key={candidate.deviceId} value={candidate.deviceId}>
              {candidate.name}
              {reachable(candidate) ? '' : ' (offline)'}
            </option>
          ))}
        </select>
        <fieldset className="repositories">
          <legend>Folder</legend>
          {repositories.length === 0 ? (
            <Notice>
              No folders are allowed on this computer yet. Add them under &quot;repositories&quot;
              in its remotectl config.
            </Notice>
          ) : (
            <ul className="repository-list">
              {repositories.map((candidate) => (
                <RepositoryChoice
                  key={candidate.id}
                  repository={candidate}
                  checked={candidate.id === repository?.id}
                  onPick={() => {
                    setRepositoryId(candidate.id);
                    setPicked('default');
                  }}
                />
              ))}
            </ul>
          )}
        </fieldset>
        {modes.length > 0 && (
          <>
            <label htmlFor="new-mode">Mode</label>
            <select
              id="new-mode"
              name="permissionMode"
              value={permissionMode}
              onChange={(event) => setPicked(event.target.value as PermissionMode)}
            >
              {modes.map((mode) => (
                <option key={mode} value={mode}>
                  {PERMISSION_MODE_LABELS[mode]}
                </option>
              ))}
            </select>
          </>
        )}
        <label htmlFor="new-prompt">Prompt</label>
        <textarea
          id="new-prompt"
          name="prompt"
          rows={4}
          maxLength={MAX_PROMPT_LENGTH}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
        {!online && <Notice>Offline. Start is available when the computer is online.</Notice>}
        <button type="submit" className="primary" disabled={!canStart}>
          Start
        </button>
      </form>
      <CommandStatus
        view={command.view}
        status={command.status}
        waiting={command.waiting}
        failure={command.failure}
      />
    </Screen>
  );
}

/**
 * The follow-up box on a session (M1-04): enabled only when the agent says the session
 * takes one (`followUp`, a background session); otherwise disabled with the reason.
 * Send asks for the passkey (D7).
 */
export function ComposeBox({
  machineId,
  session,
}: {
  readonly machineId: string;
  readonly session: Session;
}) {
  const { phone } = useAppState();
  const online = useStore(phone.realtime, (state) => reachable(state.machines[machineId]));
  const [text, setText] = useState('');
  const command = useCommand();
  const supported = session.followUp === true && session.state !== 'ended';
  const enabled = supported && online;
  const trimmed = text.trim();
  const canSend = enabled && trimmed.length > 0 && !command.sending && !command.waiting;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSend) return;
    void command.run(async () => {
      const result = await phone.instruct(machineId, session.id, trimmed);
      if (result.ok) setText('');
      return result;
    });
  };

  const reason = !supported
    ? session.state === 'ended'
      ? 'This session has ended.'
      : 'This session runs in a terminal. Continue it there.'
    : !online
      ? 'Offline.'
      : undefined;
  return (
    <>
      <form className="compose" onSubmit={submit}>
        <label htmlFor="compose-text">Message</label>
        <textarea
          id="compose-text"
          name="text"
          rows={3}
          maxLength={MAX_PROMPT_LENGTH}
          value={text}
          disabled={!enabled}
          onChange={(event) => setText(event.target.value)}
        />
        {reason !== undefined && <Notice>{reason}</Notice>}
        <button type="submit" className="primary" disabled={!canSend}>
          Send
        </button>
      </form>
      <CommandStatus
        view={command.view}
        status={command.status}
        waiting={command.waiting}
        failure={command.failure}
      />
    </>
  );
}
