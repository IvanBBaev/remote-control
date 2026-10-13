import { toolInfo } from '@remote-control/protocol';
import type { ToolKind } from '@remote-control/protocol';
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

/**
 * What the agent wants to do, the countdown, and Deny / Allow (M0-21; card rules 01 W6,
 * M1-11): the content stays hidden until a tap, Allow stays disabled while the content is
 * truncated, taps in the first `TAP_GUARD_MS` are ignored, there is no "Always" button
 * yet, and a closed or expired card has no decision buttons.
 */
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
