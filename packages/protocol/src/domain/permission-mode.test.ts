import { describe, expect, it } from 'vitest';

import { PermissionMode, permissionModesUpTo, permissionModeWithin } from './permission-mode.js';

describe('PermissionMode (M2-09)', () => {
  it.each(['bypassPermissions', 'dontAsk', 'auto', 'Default', ''])('refuses %j', (mode) => {
    expect(PermissionMode.safeParse(mode).success).toBe(false);
  });

  it('orders the ladder plan < default < acceptEdits', () => {
    expect(permissionModeWithin('plan', 'default')).toBe(true);
    expect(permissionModeWithin('default', 'default')).toBe(true);
    expect(permissionModeWithin('acceptEdits', 'default')).toBe(false);
    expect(permissionModeWithin('default', 'plan')).toBe(false);
    expect(permissionModeWithin('acceptEdits', 'acceptEdits')).toBe(true);
  });

  it('lists the modes up to a bound, least permissive first', () => {
    expect(permissionModesUpTo('plan')).toEqual(['plan']);
    expect(permissionModesUpTo('default')).toEqual(['plan', 'default']);
    expect(permissionModesUpTo('acceptEdits')).toEqual(['plan', 'default', 'acceptEdits']);
  });
});
