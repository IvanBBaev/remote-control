import { z } from 'zod';

import { DeviceId } from '../ids.js';
import { Capabilities } from './capabilities.js';

/** A computer running the agent daemon; its id is the agent's device id. */
export const Machine = z.strictObject({
  id: DeviceId,
  name: z.string().min(1).max(64),
  platform: z.enum(['darwin', 'linux', 'win32']),
  agentVersion: z.string().min(1).max(64),
  /** Capability flags, one entry per coding agent installed on the machine. */
  agents: z.array(Capabilities).max(8),
});
export type Machine = z.infer<typeof Machine>;
