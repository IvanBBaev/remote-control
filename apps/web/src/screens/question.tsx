import type { AnswerPayload, QuestionItem } from '@remote-control/protocol';
import { MAX_OTHER_LENGTH, MAX_RESPONSE_LENGTH } from '@remote-control/protocol';
import { useEffect, useId, useRef, useState } from 'react';
import { useStore } from 'zustand';

import { useAppState } from '../app-state.js';
import type { QuestionView } from '../realtime/realtime-store.js';
import { Notice } from './layout.js';
import { closedText, countdown, failureText, TAP_GUARD_MS } from './request-status.js';
import type { Failure } from './request-status.js';

/** What the user picked for one question: option labels and the "Other" text. */
export interface QuestionPick {
  readonly labels: readonly string[];
  /** `undefined` while "Other" is not chosen. */
  readonly other?: string;
}

const EMPTY: QuestionPick = { labels: [] };

/** Whether `pick` answers `item`: one choice when single-select, at least one when multi. */
export function picked(item: QuestionItem, pick: QuestionPick): boolean {
  if (pick.other !== undefined && pick.other.trim() === '') return false;
  const count = pick.labels.length + (pick.other === undefined ? 0 : 1);
  return item.multi ? count >= 1 : count === 1;
}

/** The decision payload for the picks, in question order (M1-01). */
export function answerPayload(picks: readonly QuestionPick[], response: string): AnswerPayload {
  const note = response.trim();
  return {
    answers: picks.map((pick) => ({
      labels: [...pick.labels],
      ...(pick.other === undefined ? {} : { other: pick.other.trim() }),
    })),
    ...(note === '' ? {} : { response: note }),
  };
}

function toggle(item: QuestionItem, pick: QuestionPick, label: string): QuestionPick {
  if (!item.multi) return { labels: [label] };
  const labels = pick.labels.includes(label)
    ? pick.labels.filter((entry) => entry !== label)
    : [...pick.labels, label];
  return { ...pick, labels };
}

function toggleOther(item: QuestionItem, pick: QuestionPick): QuestionPick {
  if (!item.multi) return { labels: [], other: pick.other ?? '' };
  if (pick.other === undefined) return { ...pick, other: '' };
  return { labels: pick.labels };
}

/**
 * Claude Code's `AskUserQuestion` on the phone (M1-01, 04 §2.3): one question per step
 * with its options and their descriptions, radio buttons for single-select and
 * checkboxes for multi-select, an "Other" free-text choice, Back / Next, then Send with
 * the passkey (an answer always needs one, D7). Deny and the countdown work as on the
 * approval card; taps in the first `TAP_GUARD_MS` are ignored.
 */
export function QuestionCard({ view }: { readonly view: QuestionView }) {
  const { phone } = useAppState();
  const machine = useStore(phone.realtime, (state) => state.machines[view.machineId]?.name);
  const [shownAt] = useState(() => phone.now());
  const [now, setNow] = useState(shownAt);
  const { request: question } = view;
  const [step, setStep] = useState(0);
  const [picks, setPicks] = useState<readonly QuestionPick[]>(() =>
    question.questions.map(() => EMPTY),
  );
  const [response, setResponse] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<'answer' | 'deny'>();
  const [failure, setFailure] = useState<Failure>();
  const busy = useRef(false);
  const id = useId();

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

  const item = question.questions[step]!;
  const pick = picks[step]!;
  const last = step === question.questions.length - 1;
  const ready = picks.every((entry, index) => picked(question.questions[index]!, entry));

  const change = (next: QuestionPick) => {
    setPicks((current) => current.map((entry, index) => (index === step ? next : entry)));
  };

  const send = async (kind: 'answer' | 'deny') => {
    if (busy.current || phone.now() - shownAt < TAP_GUARD_MS) return;
    busy.current = true;
    setSending(true);
    setFailure(undefined);
    const result =
      kind === 'answer'
        ? await phone.answer(view.machineId, question, answerPayload(picks, response))
        : await phone.decide(view.machineId, question, 'deny');
    busy.current = false;
    setSending(false);
    if (result.ok) setSent(kind);
    else setFailure(result.failure);
  };

  const inputType = item.multi ? 'checkbox' : 'radio';
  return (
    <article className="approval-card question-card">
      <p className="meta">
        {machine ?? 'Unknown computer'}
        {question.project !== undefined && (
          <>
            {' · '}
            <span className="project-name">{question.project}</span>
          </>
        )}
      </p>
      {question.questions.length > 1 && (
        <p className="meta">
          Question {step + 1} of {question.questions.length}
        </p>
      )}
      <fieldset className="question-options" disabled={!open || sent !== undefined || sending}>
        <legend>
          {item.header !== undefined && <span className="meta">{item.header}</span>}
          <h2>{item.text}</h2>
          {item.multi && <span className="meta">Choose one or more.</span>}
        </legend>
        {item.options.map((option, index) => (
          <label key={option.label} className="question-option">
            <input
              type={inputType}
              name={`${id}-${String(step)}`}
              checked={pick.labels.includes(option.label)}
              onChange={() => change(toggle(item, pick, option.label))}
              aria-describedby={
                option.description === undefined
                  ? undefined
                  : `${id}-${String(step)}-${String(index)}`
              }
            />
            <span>
              {option.label}
              {option.description !== undefined && (
                <span className="meta" id={`${id}-${String(step)}-${String(index)}`}>
                  {option.description}
                </span>
              )}
            </span>
          </label>
        ))}
        <label className="question-option">
          <input
            type={inputType}
            name={`${id}-${String(step)}`}
            checked={pick.other !== undefined}
            onChange={() => change(toggleOther(item, pick))}
          />
          <span>Other</span>
        </label>
        {pick.other !== undefined && (
          <input
            type="text"
            aria-label="Your answer"
            maxLength={MAX_OTHER_LENGTH}
            value={pick.other}
            onChange={(event) => change({ ...pick, other: event.target.value })}
          />
        )}
        {last && (
          <label className="question-note">
            Note for the agent (optional)
            <textarea
              maxLength={MAX_RESPONSE_LENGTH}
              value={response}
              onChange={(event) => setResponse(event.target.value)}
            />
          </label>
        )}
      </fieldset>
      {open && <p className="countdown meta">Time left: {countdown(left)}</p>}
      {expired && <Notice>Expired. The terminal is asking again.</Notice>}
      {closed !== undefined && <Notice>{closed}</Notice>}
      {open && sent !== undefined && (
        <Notice>{sent === 'answer' ? 'Answer' : 'Deny'} sent. Waiting for your computer…</Notice>
      )}
      {failure !== undefined && <p className="notice error">{failureText(failure)}</p>}
      {open && sent === undefined && (
        <>
          <div className="actions split">
            <button
              type="button"
              disabled={step === 0 || sending}
              onClick={() => setStep(step - 1)}
            >
              Back
            </button>
            {last ? (
              <button
                type="button"
                className="primary"
                disabled={sending || !ready}
                onClick={() => void send('answer')}
              >
                Send answer
              </button>
            ) : (
              <button
                type="button"
                className="primary"
                disabled={sending || !picked(item, pick)}
                onClick={() => setStep(step + 1)}
              >
                Next
              </button>
            )}
          </div>
          <div className="actions">
            <button
              type="button"
              className="danger"
              disabled={sending}
              onClick={() => void send('deny')}
            >
              Deny
            </button>
          </div>
        </>
      )}
    </article>
  );
}
