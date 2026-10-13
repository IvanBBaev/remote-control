import { useEffect, useRef, useState } from 'react';
import { Navigate, useParams } from 'react-router';
import { useStore } from 'zustand';

import { useAppState } from '../app-state.js';
import type { AssertDecisionResult } from '../auth/assert-decision.js';
import { pendingRequests } from '../realtime/realtime-store.js';
import type { RealtimeState, RequestView } from '../realtime/realtime-store.js';
import { Notice, Screen } from './layout.js';

/** Taps this soon after the card appears are ignored: no accidental Allow (05 Rec-2). */
export const TAP_GUARD_MS = 600;
/** The argument line on the card; the rest is behind "Show details". */
export const SUMMARY_LENGTH = 60;

const mostUrgent = (state: RealtimeState): string | undefined =>
  pendingRequests(state)[0]?.request.id;
const isConnected = (state: RealtimeState): boolean => state.connection === 'open';

/** The first line of `content`, cut to `SUMMARY_LENGTH` with an ellipsis. */
export function summaryLine(content: string): string {
  const [first = ''] = content.split('\n', 1);
  const cut = first.length > SUMMARY_LENGTH || first.length < content.length;
  return cut ? `${first.slice(0, SUMMARY_LENGTH).trimEnd()}…` : first;
}

/** `m:ss` for a countdown. */
export function countdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
}

type Failure = Extract<AssertDecisionResult, { ok: false }>['failure'];

function failureText(failure: Failure): string {
  if (failure === 'cancelled') return 'Face ID was cancelled. Nothing was sent.';
  if (failure === 'offline') return 'You are offline. Nothing was sent.';
  if (failure === 'rate_limited') return 'Too many attempts. Wait a minute and try again.';
  return 'Could not confirm with your passkey. Nothing was sent.';
}

const OUTCOMES: Record<NonNullable<RequestView['outcome']>, string> = {
  allow: 'Allowed.',
  deny: 'Denied.',
  terminal: 'Answered in the terminal.',
  withdrawn: 'The agent no longer needs this answer.',
};

const REJECTIONS: Partial<Record<string, string>> = {
  already_resolved: 'Already answered elsewhere.',
  expired: 'Too late: the request had expired.',
  too_late: 'Too late: the request had expired.',
  unknown_request: 'The computer no longer has this request.',
};

/** The final state of a request that is no longer pending, or a refused decision. */
function closedText(view: RequestView): string | undefined {
  if (view.result?.result === 'rejected') {
    return REJECTIONS[view.result.reason] ?? 'Your computer refused the decision.';
  }
  if (view.relayError !== undefined) return 'The relay refused the decision. Try again.';
  if (view.status === 'expired') return 'Expired. The terminal is asking again.';
  if (view.status === 'resolved' && view.outcome !== undefined) return OUTCOMES[view.outcome];
  return undefined;
}

/** What the agent wants to do, the countdown, and Deny / Allow (M0-21). */
export function ApprovalCard({ view }: { readonly view: RequestView }) {
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

  return (
    <article className="approval-card">
      <p className="meta">{machine ?? 'Unknown computer'}</p>
      <h2>{request.toolLabel}</h2>
      <pre className="command">{summaryLine(request.content)}</pre>
      <button type="button" aria-expanded={details} onClick={() => setDetails((d) => !d)}>
        {details ? 'Hide details' : 'Show details'}
      </button>
      {details && (
        <pre className="command details">
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
 * One approval request. A push carries the doorbell's id, not the request's (D5), so an
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
    <Screen title="Approval request" back="/sessions">
      {view === undefined ? (
        <Notice>{connected ? 'Nothing is waiting for you.' : 'Connecting…'}</Notice>
      ) : (
        <ApprovalCard key={view.request.id} view={view} />
      )}
    </Screen>
  );
}
