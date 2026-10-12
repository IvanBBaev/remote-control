import { z } from 'zod';

import { SessionId } from '../ids.js';

/** A follow-up prompt for a running session. */
export const Instruction = z.strictObject({
  sessionId: SessionId,
  text: z.string().min(1).max(16_384),
});
export type Instruction = z.infer<typeof Instruction>;
