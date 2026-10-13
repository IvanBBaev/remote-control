import { toolInfo } from '@remote-control/protocol';
import type { AlwaysDestination, ToolKind } from '@remote-control/protocol';
import { useEffect, useRef, useState } from 'react';
import { Navigate, useParams } from 'react-router';
import { useStore } from 'zustand';

import { useAppState } from '../app-state.js';
import { pendingRequests } from '../realtime/realtime-store.js';
import type { ApprovalView, RealtimeState } from '../realtime/realtime-store.js';
import { Notice, Screen } from './layout.js';
import { QuestionCard } from './question.js';
import {
  closedText,
  countdown,
  failureText,
  RELEASED_TEXT,
  TAP_GUARD_MS,
} from './request-status.js';
import type { Failure } from './request-status.js';
import { useWideLayout } from './split.js';

export { countdown, TAP_GUARD_MS } from './request-status.js';

const SENT_TEXT = {
  allow: 'Allow',
  always: 'Always (this session)',
  deny: 'Deny',
  terminal: 'Reply in terminal',
} as const;
type SentKind = keyof typeof SENT_TEXT;

/** Allow and Deny from the keyboard on a wide screen (M2-05). */
export const ALLOW_KEY = 'a';
export const DENY_KEY = 'd';

/** A key typed into a field is text, not a shortcut. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** The "Always" button for each destination the agent offers (M2-07). */
export const ALWAYS_TEXT: Record<AlwaysDestination, string> = {
  session: 'Always (this session)',
  localSettings: 'Always (this project, only me)',
  projectSettings: 'Always (this project, everyone)',
};

const mostUrgent = (state: RealtimeState): string | undefined =>
  pendingRequests(state)[0]?.request.id;
const isConnected = (state: RealtimeState): boolean => state.connection === 'open';

const REVEAL_NOUNS: Partial<Record<ToolKind, string>> = {
  command: 'command',
  file: 'file',
  search: 'search',
  web: 'address',
};

/**
 * What the reveal button names (01 W6, §5.3): a command or path is never on screen
 * before the user taps for it. Keyed by the tool's kind, so an unknown tool says "details".
 */
export function revealNoun(toolName: string): string {
  return REVEAL_NOUNS[toolInfo(toolName).kind] ?? 'details';
}

/**
 * What the agent wants to do, the countdown, and Deny / Allow (M0-21; card rules 01 W6,
 * M1-11): the content stays hidden until a tap, Allow stays disabled while the content is
 * truncated, taps in the first `TAP_GUARD_MS` are ignored, and a closed or expired card has
 * no decision buttons. "Always (this session)" (M1-02, D24) appears only when the agent
 * offered session rules; it lists every rule it grants, needs the passkey like Allow, and
 * is disabled with it while the content is truncated. When the agent's
 * `always.destinations` adds settings files (M2-07), there is one "Always" button per
 * destination, and the picked one is signed. "Reply in terminal" (M1-03) hands
 * the request back to Claude Code's own prompt, without the passkey.
 */
export function ApprovalCard({ view }: { readonly view: ApprovalView }) {
  const { phone } = useAppState();
  const machine = useStore(phone.realtime, (state) => state.machines[view.machineId]?.name);
  const [shownAt] = useState(() => phone.now());
  const [now, setNow] = useState(shownAt);
  const [details, setDetails] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<SentKind>();
  const [sentText, setSentText] = useState('');
  const [failure, setFailure] = useState<Failure>();
  const busy = useRef(false);
  const { request } = view;

  const left = view.deadline - now;
  useEffect(() => {
    if (view.status !== 'pending' || left <= 0) return;
    const handle = phone.after(Math.min(1000, left), () => {
      setNow(phone.now());
    });
    return () => {
      handle.cancel();
    };
  }, [phone, view.status, left]);

  const closed = closedText(view);
  // This phone's "Reply in terminal" won: the request is over here, too.
  const released = sent === 'terminal' && view.result?.result === 'accepted';
  const expired = view.status === 'pending' && !released && left <= 0;
  const open = view.status === 'pending' && !expired && !released && closed === undefined;

  const decide = async (kind: SentKind, destination?: AlwaysDestination) => {
    if (busy.current || phone.now() - shownAt < TAP_GUARD_MS) return;
    busy.current = true;
    setSending(true);
    setFailure(undefined);
    const result =
      kind === 'terminal'
        ? await phone.release(view.machineId, request)
        : destination === undefined
          ? await phone.decide(view.machineId, request, kind)
          : await phone.decide(view.machineId, request, kind, destination);
    busy.current = false;
    setSending(false);
    if (result.ok) {
      setSent(kind);
      setSentText(destination === undefined ? SENT_TEXT[kind] : ALWAYS_TEXT[destination]);
    } else setFailure(result.failure);
  };

  // Keyboard shortcuts (M2-05) take the same path as a tap: the passkey still asks (UV).
  const deciding = open && sent === undefined;
  useEffect(() => {
    if (!deciding) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
      if (isTyping(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === DENY_KEY) {
        event.preventDefault();
        void decide('deny');
      } else if (key === ALLOW_KEY && !request.truncated) {
        event.preventDefault();
        void decide('allow');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const wide = useWideLayout();

  const noun = revealNoun(request.toolName);
  const destinations = request.alwaysDestinations ?? ['session'];
  return (
    <article className="approval-card">
      <p className="meta">
        {machine ?? 'Unknown computer'}
        {request.project !== undefined && (
          <>
            {' · '}
            <span className="project-name">{request.project}</span>
          </>
        )}
      </p>
      <h2>{request.toolLabel}</h2>
      <button type="button" aria-expanded={details} onClick={() => setDetails((d) => !d)}>
        {details ? `Hide ${noun}` : `Show ${noun}`}
      </button>
      {details && (
        <pre className="command details" tabIndex={0}>
          {request.toolName}
          {'\n'}
          {request.content}
        </pre>
      )}
      {request.truncated && (
        <Notice>This request is too long to show in full. Answer it in the terminal.</Notice>
      )}
      {open && <p className="countdown meta">Time left: {countdown(left)}</p>}
      {expired && <Notice>Expired. The terminal is asking again.</Notice>}
      {closed !== undefined && <Notice>{closed}</Notice>}
      {released && <Notice>{RELEASED_TEXT}</Notice>}
      {open && sent !== undefined && <Notice>{sentText} sent. Waiting for your computer…</Notice>}
      {failure !== undefined && <p className="notice error">{failureText(failure)}</p>}
      {open && sent === undefined && (
        <div className="actions split">
          <button
            type="button"
            className="danger"
            disabled={sending}
            aria-keyshortcuts="D"
            onClick={() => void decide('deny')}
          >
            Deny
          </button>
          <button
            type="button"
            className="primary"
            disabled={sending || request.truncated}
            aria-keyshortcuts="A"
            onClick={() => void decide('allow')}
          >
            Allow
          </button>
        </div>
      )}
      {deciding && wide && (
        <p className="meta keyboard-hint">
          Keyboard: <kbd>A</kbd> allows, <kbd>D</kbd> denies. Your passkey still confirms.
        </p>
      )}
      {open && sent === undefined && request.alwaysSupported && (
        <div className="always">
          <p className="meta">
            {destinations.length > 1 ? 'Always allow:' : 'Always allow in this session:'}
          </p>
          <ul className="always-rules">
            {request.suggestions.map((rule) => (
              <li key={rule}>
                <code>{rule}</code>
              </li>
            ))}
          </ul>
          <div className="actions">
            {destinations.map((destination) => (
              <button
                key={destination}
                type="button"
                disabled={sending || request.truncated}
                onClick={() => void decide('always', destination)}
              >
                {ALWAYS_TEXT[destination]}
              </button>
            ))}
          </div>
        </div>
      )}
      {open && sent === undefined && (
        <div className="actions">
          <button type="button" disabled={sending} onClick={() => void decide('terminal')}>
            Reply in terminal
          </button>
        </div>
      )}
    </article>
  );
}

/**
 * One approval request or question (M1-01). A push carries the doorbell's id, not the request's (D5), so an
 * unknown id falls back to the most urgent pending request (05 Rec-2).
 */
export function RequestScreen() {
  const { id = '' } = useParams();
  const { phone } = useAppState();
  const view = useStore(phone.realtime, (state) => state.requests[id]);
  const urgent = useStore(phone.realtime, mostUrgent);
  const connected = useStore(phone.realtime, isConnected);
  if (view === undefined && urgent !== undefined) {
    return <Navigate to={`/requests/${urgent}`} replace />;
  }
  return (
    <Screen title={view?.kind === 'question' ? 'Question' : 'Approval request'} back="/sessions">
      {view === undefined ? (
        <Notice>{connected ? 'Nothing is waiting for you.' : 'Connecting…'}</Notice>
      ) : view.kind === 'question' ? (
        <QuestionCard key={view.request.id} view={view} />
      ) : (
        <ApprovalCard key={view.request.id} view={view} />
      )}
    </Screen>
  );
}
