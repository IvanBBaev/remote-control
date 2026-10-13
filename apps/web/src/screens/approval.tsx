import { toolInfo } from '@remote-control/protocol';
import type { ToolKind } from '@remote-control/protocol';
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

export { countdown, TAP_GUARD_MS } from './request-status.js';

const SENT_TEXT = {
  allow: 'Allow',
  always: 'Always (this session)',
  deny: 'Deny',
  terminal: 'Reply in terminal',
} as const;
type SentKind = keyof typeof SENT_TEXT;

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
 * is disabled with it while the content is truncated. "Reply in terminal" (M1-03) hands
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

  const decide = async (kind: SentKind) => {
    if (busy.current || phone.now() - shownAt < TAP_GUARD_MS) return;
    busy.current = true;
    setSending(true);
    setFailure(undefined);
    const result =
      kind === 'terminal'
        ? await phone.release(view.machineId, request)
        : await phone.decide(view.machineId, request, kind);
    busy.current = false;
    setSending(false);
    if (result.ok) setSent(kind);
    else setFailure(result.failure);
  };

  const noun = revealNoun(request.toolName);
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
      {open && sent !== undefined && (
        <Notice>{SENT_TEXT[sent]} sent. Waiting for your computer…</Notice>
      )}
      {failure !== undefined && <p className="notice error">{failureText(failure)}</p>}
      {open && sent === undefined && (
        <div className="actions split">
          <button
            type="button"
            className="danger"
            disabled={sending}
            onClick={() => void decide('deny')}
          >
            Deny
          </button>
          <button
            type="button"
            className="primary"
            disabled={sending || request.truncated}
            onClick={() => void decide('allow')}
          >
            Allow
          </button>
        </div>
      )}
      {open && sent === undefined && request.alwaysSupported && (
        <div className="always">
          <p className="meta">Always allow in this session:</p>
          <ul className="always-rules">
            {request.suggestions.map((rule) => (
              <li key={rule}>
                <code>{rule}</code>
              </li>
            ))}
          </ul>
          <div className="actions">
            <button
              type="button"
              disabled={sending || request.truncated}
              onClick={() => void decide('always')}
            >
              Always (this session)
            </button>
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
