import { z } from 'zod';

import { AgentId } from '../ids.js';

/** What one coding agent on a machine supports; the phone hides what it cannot do. */
export const Capabilities = z.strictObject({
  agent: AgentId,
  /** "Always" from the phone (D24). */
  always: z.boolean(),
  /** Answering `AskUserQuestion`-style questions. */
  questions: z.boolean(),
  /** Follow-up instructions to a running session. */
  instructions: z.boolean(),
  /** Starting a new session in an allow-listed repository. */
  startSession: z.boolean(),
});
export type Capabilities = z.infer<typeof Capabilities>;
