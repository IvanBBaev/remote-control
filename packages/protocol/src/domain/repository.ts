import { z } from 'zod';

import { DeviceId, OpaqueId } from '../ids.js';
import { PermissionMode } from './permission-mode.js';

/** An entry of a machine's local allow-list; the phone can only pick, never edit. */
export const Repository = z.strictObject({
  id: OpaqueId,
  machineId: DeviceId,
  /** Folder name, shown by default. */
  name: z.string().min(1).max(128),
  /** Full path, shown only on a deliberate tap. */
  path: z.string().min(1).max(4096),
  /**
   * The most permissive mode a phone may start a session in here (M2-09), set only in the
   * agent config. Left out (an older agent), only the default mode is offered.
   */
  maxPermissionMode: PermissionMode.optional(),
});
export type Repository = z.infer<typeof Repository>;
