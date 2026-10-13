import { z } from 'zod';

import { DeviceId, OpaqueId } from '../ids.js';
import { PermissionMode } from './permission-mode.js';

/**
 * Start a session in an allow-listed repository. Only the repository id travels; the
 * agent resolves it against its local allow-list and spawn argv (02 §4.1). A
 * `permissionMode` (M2-09) must lie within the repository's `maxPermissionMode`; left out,
 * the session starts in the CLI's default mode.
 */
export const StartSession = z.strictObject({
  machineId: DeviceId,
  repositoryId: OpaqueId,
  prompt: z.string().min(1).max(16_384),
  permissionMode: PermissionMode.optional(),
});
export type StartSession = z.infer<typeof StartSession>;
