import { z } from 'zod';

import { EpochMs, RequestId, SessionId, Sha256Hex } from '../ids.js';

/** Claude Code's `AskUserQuestion` limits (04 §2.3): 1–4 questions, 2–4 options each. */
export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;

/** One option of a question, rendered with its exact label. */
export const QuestionOption = z.strictObject({
  label: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
});
export type QuestionOption = z.infer<typeof QuestionOption>;

/** One question: its exact text, the short `header` chip, the options, single or multi. */
export const QuestionItem = z.strictObject({
  text: z.string().min(1).max(1000),
  header: z.string().min(1).max(200).optional(),
  options: z.array(QuestionOption).min(MIN_OPTIONS).max(MAX_OPTIONS),
  multi: z.boolean(),
});
export type QuestionItem = z.infer<typeof QuestionItem>;

/**
 * A question the agent asks (`AskUserQuestion`, 01 W7). `requestHash` binds the answer
 * to these exact questions (D7); `project` is the folder name only (D21) and travels
 * only inside the sealed session.
 */
export const Question = z.strictObject({
  id: RequestId,
  sessionId: SessionId,
  requestHash: Sha256Hex,
  project: z.string().min(1).max(128).optional(),
  expiresAt: EpochMs,
  questions: z.array(QuestionItem).min(1).max(MAX_QUESTIONS),
});
export type Question = z.infer<typeof Question>;
