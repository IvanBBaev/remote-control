import { z } from 'zod';

import { DeviceId, EpochMs } from '../ids.js';

/** A phone paired with a machine (M1-07), as the machine's `peers.json` lists it. */
export const PairedDevice = z.strictObject({
  id: DeviceId,
  name: z.string().min(1).max(64),
  pairedAt: EpochMs,
});
export type PairedDevice = z.infer<typeof PairedDevice>;
