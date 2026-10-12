import { z } from 'zod';

import { RequestId } from '../ids.js';

/**
 * The phone's answer to a permission request (01 W2 `decision`). The bytes that bind it
 * to the request and the user are the `CanonicalDecision` (D7).
 */
export const Decision = z.strictObject({
  requestId: RequestId,
  behavior: z.enum(['allow', 'deny', 'always', 'terminal']),
  /** For `always`: where the rule is stored, as offered by the request's suggestions. */
  scope: z.string().min(1).max(200).optional(),
  /** For `deny`: shown to the agent. */
  reason: z.string().max(1000).optional(),
});
export type Decision = z.infer<typeof Decision>;
