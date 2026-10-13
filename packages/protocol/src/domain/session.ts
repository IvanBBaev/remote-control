import { z } from 'zod';

import { AgentId, DeviceId, OpaqueId, SessionId } from '../ids.js';

/** One file the session changed, with line counts. */
export const ChangedFile = z.strictObject({
  name: z.string().min(1).max(4096),
  added: z.int().nonnegative(),
  removed: z.int().nonnegative(),
});
export type ChangedFile = z.infer<typeof ChangedFile>;

/** The thin session view (D21): state, last prompt and answer, recent steps, files. */
export const Session = z.strictObject({
  id: SessionId,
  machineId: DeviceId,
  /** `null` when the session runs outside every allow-listed repository. */
  repositoryId: OpaqueId.nullable(),
  agent: AgentId,
  state: z.enum(['starting', 'working', 'waiting', 'idle', 'ended']),
  statusText: z.string().max(200),
  lastPrompt: z.string().max(4000).nullable(),
  lastAnswer: z.string().max(4000).nullable(),
  /** The most recent steps, at most 20, each at most 200 characters. */
  steps: z.array(z.string().max(200)).max(20),
  changedFiles: z.array(ChangedFile).max(50),
  /** The agent CLI's session name, when it has one (M1-04). */
  name: z.string().min(1).max(64).nullable().optional(),
  /** Whether the session takes a follow-up instruction from the phone (M1-04). */
  followUp: z.boolean().optional(),
  /** The last live feed event the content includes (M1-05); later events carry more. */
  feedSeq: z.int().nonnegative().optional(),
});
export type Session = z.infer<typeof Session>;
