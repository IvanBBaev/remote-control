import { z } from 'zod';

import { DeviceId, OpaqueId } from '../ids.js';

/** An entry of a machine's local allow-list; the phone can only pick, never edit. */
export const Repository = z.strictObject({
  id: OpaqueId,
  machineId: DeviceId,
  /** Folder name, shown by default. */
  name: z.string().min(1).max(128),
  /** Full path, shown only on a deliberate tap. */
  path: z.string().min(1).max(4096),
});
export type Repository = z.infer<typeof Repository>;
