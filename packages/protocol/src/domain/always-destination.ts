import { z } from 'zod';

/**
 * Where an "Always" rule is stored (D24, 04 Q5): `session` (gone when the session ends),
 * `localSettings` (`.claude/settings.local.json`, this user only) or `projectSettings`
 * (`.claude/settings.json`, shared with everyone who checks out the repository).
 */
export const AlwaysDestination = z.enum(['session', 'localSettings', 'projectSettings']);
export type AlwaysDestination = z.infer<typeof AlwaysDestination>;

/** The destinations that persist a rule; the canonical `always` payload names one of them. */
export const SETTINGS_DESTINATIONS: ReadonlySet<string> = new Set([
  'localSettings',
  'projectSettings',
]);
