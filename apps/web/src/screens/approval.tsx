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
import { closedText, countdown, failureText, TAP_GUARD_MS } from './request-status.js';
import type { Failure } from './request-status.js';

export { countdown, TAP_GUARD_MS } from './request-status.js';

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
 * truncated, taps in the first `TAP_GUARD_MS` are ignored, there is no "Always" button
 * yet, and a closed or expired card has no decision buttons.
 */
export function ApprovalCard({ view }: { readonly view: ApprovalView }) {
  const { phone } = useAppState();
  const machine = useStore(phone.realtime, (state) => state.machines[view.machineId]?.name);
  const [shownAt] = useState(() => phone.now());
  const [now, setNow] = useState(shownAt);
  const [details, setDetails] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<'allow' | 'deny'>();
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
  const expired = view.status === 'pending' && left <= 0;
  const open = view.status === 'pending' && !expired && closed === undefined;

  const decide = async (kind: 'allow' | 'deny') => {
    if (busy.current || phone.now() - shownAt < TAP_GUARD_MS) return;
    busy.current = true;
    setSending(true);
    setFailure(undefined);
    const result = await phone.decide(view.machineId, request, kind);
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
      {open && sent !== undefined && (
        <Notice>{sent === 'allow' ? 'Allow' : 'Deny'} sent. Waiting for your computer…</Notice>
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
      <div className="actions">
        {/* Typed replies arrive with M1-03. */}
        <button type="button" disabled>
          Reply in terminal
        </button>
      </div>
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
