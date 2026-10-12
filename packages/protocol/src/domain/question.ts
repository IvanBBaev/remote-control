import { z } from 'zod';

import { EpochMs, RequestId, SessionId, Sha256Hex } from '../ids.js';

/** One option of a question, rendered with its exact label. */
export const QuestionOption = z.strictObject({
  label: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
});
export type QuestionOption = z.infer<typeof QuestionOption>;

/** A question the agent asks (`AskUserQuestion`): up to 4 questions × 8 options. */
export const Question = z.strictObject({
  id: RequestId,
  sessionId: SessionId,
  requestHash: Sha256Hex,
  expiresAt: EpochMs,
  questions: z
    .array(
      z.strictObject({
        text: z.string().min(1).max(1000),
        options: z.array(QuestionOption).max(8),
        multi: z.boolean(),
      }),
    )
    .min(1)
    .max(4),
});
export type Question = z.infer<typeof Question>;
