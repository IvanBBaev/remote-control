import { z } from 'zod';

/**
 * The permission modes a phone may start a session in (M2-09, 04 §5.4), least to most
 * permissive. `bypassPermissions`, `dontAsk` and `auto` are not on the ladder: no message
 * can name them, so the agent can never emit them (D13).
 */
export const PERMISSION_MODES = ['plan', 'default', 'acceptEdits'] as const;

export const PermissionMode = z.enum(PERMISSION_MODES);
export type PermissionMode = z.infer<typeof PermissionMode>;

/** Whether `mode` is at or below `max` on the ladder. */
export function permissionModeWithin(mode: PermissionMode, max: PermissionMode): boolean {
  return PERMISSION_MODES.indexOf(mode) <= PERMISSION_MODES.indexOf(max);
}

/** The modes a repository bounded by `max` allows, least permissive first. */
export function permissionModesUpTo(max: PermissionMode): PermissionMode[] {
  return PERMISSION_MODES.filter((mode) => permissionModeWithin(mode, max));
}
