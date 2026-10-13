import { z } from 'zod';

import { canonicalJson } from './canonical-json.js';
import { MAX_OPTIONS, MAX_QUESTIONS } from './domain/question.js';

/** Longest "Other" free text per question. */
export const MAX_OTHER_LENGTH = 1000;
/** Longest free-text `response` for the whole question set (04 §2.3). */
export const MAX_RESPONSE_LENGTH = 2000;

const FreeText = (max: number) => z.string().min(1).max(max).regex(/\S/, 'blank text');

/**
 * The answer to one question, by position: the exact labels picked and/or the "Other"
 * free text. Whether the labels exist and how many a single-select question takes is
 * the agent's check against the pending question, not the schema's.
 */
export const QuestionAnswer = z.strictObject({
  labels: z.array(z.string().min(1).max(200)).max(MAX_OPTIONS),
  other: FreeText(MAX_OTHER_LENGTH).optional(),
});
export type QuestionAnswer = z.infer<typeof QuestionAnswer>;

/**
 * What an `answer` decision carries in `CanonicalDecision.payload` (D7, D11): one entry
 * per question in the order asked, and an optional free-text `response`. The payload is
 * covered by the decision hash, so the passkey assertion signs the exact answer.
 */
export const AnswerPayload = z.strictObject({
  answers: z.array(QuestionAnswer).min(1).max(MAX_QUESTIONS),
  response: FreeText(MAX_RESPONSE_LENGTH).optional(),
});
export type AnswerPayload = z.infer<typeof AnswerPayload>;

/** The canonical JSON string the phone puts into `CanonicalDecision.payload`. */
export function encodeAnswerPayload(answer: AnswerPayload): string {
  return canonicalJson(AnswerPayload.parse(answer));
}

/** Parses an `answer` decision's payload; `undefined` for anything that is not one. */
export function parseAnswerPayload(payload: string | null): AnswerPayload | undefined {
  if (payload === null) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return undefined;
  }
  const parsed = AnswerPayload.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}
