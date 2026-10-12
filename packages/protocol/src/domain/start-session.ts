import { z } from 'zod';

import { DeviceId, OpaqueId } from '../ids.js';

/**
 * Start a session in an allow-listed repository. Only the repository id travels; the
 * agent resolves it against its local allow-list and spawn argv (02 §4.1).
 */
export const StartSession = z.strictObject({
  machineId: DeviceId,
  repositoryId: OpaqueId,
  prompt: z.string().min(1).max(16_384),
});
export type StartSession = z.infer<typeof StartSession>;
