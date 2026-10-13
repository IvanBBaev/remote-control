import { MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS, Question } from '@remote-control/protocol';
import type { AnswerPayload } from '@remote-control/protocol';
import { z } from 'zod';

import type { QuestionAnswers } from '../ports/agent-adapter.js';
import { projectName } from './approval-view.js';
import type { PendingRequest } from './pending-store.js';

/**
 * Claude Code's `AskUserQuestion` input (04 §2.3), as far as the phone needs it. Unknown
 * keys pass: the hook output returns the questions verbatim, never this parse.
 */
const AskUserQuestionInput = z.looseObject({
  questions: z
    .array(
      z.looseObject({
        question: z.string(),
        header: z.string().optional(),
        options: z
          .array(z.looseObject({ label: z.string(), description: z.string().optional() }))
          .min(MIN_OPTIONS)
          .max(MAX_OPTIONS),
        multiSelect: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(MAX_QUESTIONS),
});
type AskUserQuestionInput = z.infer<typeof AskUserQuestionInput>;
type AskedQuestion = AskUserQuestionInput['questions'][number];

/** The questions of a pending question request; `undefined` when they are not answerable. */
function askedQuestions(request: PendingRequest): readonly AskedQuestion[] | undefined {
  if (request.kind !== 'question') return undefined;
  const parsed = AskUserQuestionInput.safeParse(request.payload['tool_input']);
  if (!parsed.success) return undefined;
  const { questions } = parsed.data;
  // The answers are keyed by question text (04 §2.3): two equal texts cannot both be answered.
  const texts = new Set(questions.map((item) => item.question));
  return texts.size === questions.length ? questions : undefined;
}

/**
 * The phone's view of a pending `AskUserQuestion` (M1-01). `undefined` when the input is
 * not something the phone can answer (malformed, outside the 1–4 questions / 2–4 options
 * limits, repeated question text, a session id the protocol does not accept); such a
 * request stays with the terminal, like any other it cannot show.
 */
export function questionView(request: PendingRequest, hash: string): Question | undefined {
  const questions = askedQuestions(request);
  if (questions === undefined) return undefined;
  const project = projectName(request.payload['cwd']);
  const parsed = Question.safeParse({
    id: request.id,
    sessionId: request.sessionId,
    requestHash: hash,
    ...(project === undefined ? {} : { project }),
    expiresAt: request.deadline,
    questions: questions.map((item) => ({
      text: item.question,
      ...(item.header === undefined ? {} : { header: item.header }),
      options: item.options.map((entry) => ({
        label: entry.label,
        ...(entry.description === undefined ? {} : { description: entry.description }),
      })),
      multi: item.multiSelect === true,
    })),
  });
  return parsed.success ? parsed.data : undefined;
}

/** One answer's value: the picked labels, then the "Other" text, joined with ", ". */
function answerValue(item: AskedQuestion, answer: AnswerPayload['answers'][number]) {
  const labels = new Set(item.options.map((entry) => entry.label));
  if (new Set(answer.labels).size !== answer.labels.length) return undefined;
  if (answer.labels.some((label) => !labels.has(label))) return undefined;
  const parts = answer.other === undefined ? answer.labels : [...answer.labels, answer.other];
  const fits = item.multiSelect === true ? parts.length >= 1 : parts.length === 1;
  return fits ? parts.join(', ') : undefined;
}

/**
 * Checks a phone's answer against the pending questions and turns it into the answers
 * Claude Code expects (question text → value). `undefined` when it does not fit: a
 * different number of answers, an unknown or repeated label, none or more than one
 * choice for a single-select question, nothing chosen for a multi-select one.
 */
export function questionAnswers(
  request: PendingRequest,
  payload: AnswerPayload,
): QuestionAnswers | undefined {
  const questions = askedQuestions(request);
  if (questions?.length !== payload.answers.length) return undefined;
  const answers: Record<string, string> = {};
  for (const [index, item] of questions.entries()) {
    const value = answerValue(item, payload.answers[index]!);
    if (value === undefined) return undefined;
    answers[item.question] = value;
  }
  return payload.response === undefined ? { answers } : { answers, response: payload.response };
}
