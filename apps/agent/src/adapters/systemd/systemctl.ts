// One of the process modules allowed to import child_process (D13, D22, M1-08).
// It runs only the literal `/usr/bin/systemctl` and `/usr/bin/loginctl` binaries, never a
// shell, and every argv comes from an `...Argv` builder that returns an array literal;
// `scripts/check-argv-policy.mjs` enforces all three rules for this file.
import { spawn } from 'node:child_process';

import type { Systemctl } from '../../ports/systemctl.js';
import { collect } from '../process-collect.js';

/** The only unit the agent ever manages. */
const UNIT = 'remotectl.service';
const SHOW_PROPERTIES =
  '--property=LoadState,ActiveState,SubState,MainPID,ExecMainStatus,UnitFileState';

/** A systemctl or loginctl argument was refused before any process started. */
export class SystemctlArgumentError extends Error {
  override readonly name = 'SystemctlArgumentError';
}

function checkUnit(unit: string): string {
  if (unit !== UNIT) throw new SystemctlArgumentError(`unit must be ${UNIT}`);
  return unit;
}

function checkUid(uid: number): string {
  if (!Number.isSafeInteger(uid) || uid < 0) throw new SystemctlArgumentError('invalid uid');
  return String(uid);
}

/** `systemctl --user daemon-reload`. */
export function daemonReloadArgv(): string[] {
  return ['--user', 'daemon-reload'];
}

/** `systemctl --user enable --now remotectl.service`. */
export function enableNowArgv(unit: string): string[] {
  return ['--user', 'enable', '--now', checkUnit(unit)];
}

/** `systemctl --user disable --now remotectl.service`. */
export function disableNowArgv(unit: string): string[] {
  return ['--user', 'disable', '--now', checkUnit(unit)];
}

/** `systemctl --user restart remotectl.service`. */
export function restartArgv(unit: string): string[] {
  return ['--user', 'restart', checkUnit(unit)];
}

/** `systemctl --user show remotectl.service --property=…`. */
export function showArgv(unit: string): string[] {
  return ['--user', 'show', checkUnit(unit), SHOW_PROPERTIES];
}

/** `loginctl enable-linger` (no user: the caller). */
export function enableLingerArgv(): string[] {
  return ['enable-linger'];
}

/**
 * `loginctl show-user <uid> --property=Linger`. The uid is explicit: without a user
 * argument `show-user` describes the login manager, not the caller.
 */
export function showLingerArgv(uid: number): string[] {
  return ['show-user', checkUid(uid), '--property=Linger'];
}

/** `Systemctl` over the real `/usr/bin/systemctl` and `/usr/bin/loginctl` (Linux only). */
export const systemSystemctl: Systemctl = {
  daemonReload() {
    const argv = daemonReloadArgv();
    return collect(
      spawn('/usr/bin/systemctl', argv, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  },
  enableNow(unit) {
    const argv = enableNowArgv(unit);
    return collect(
      spawn('/usr/bin/systemctl', argv, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  },
  disableNow(unit) {
    const argv = disableNowArgv(unit);
    return collect(
      spawn('/usr/bin/systemctl', argv, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  },
  restart(unit) {
    const argv = restartArgv(unit);
    return collect(
      spawn('/usr/bin/systemctl', argv, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  },
  show(unit) {
    const argv = showArgv(unit);
    return collect(
      spawn('/usr/bin/systemctl', argv, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  },
  enableLinger() {
    const argv = enableLingerArgv();
    return collect(
      spawn('/usr/bin/loginctl', argv, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  },
  showLinger(uid) {
    const argv = showLingerArgv(uid);
    return collect(
      spawn('/usr/bin/loginctl', argv, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  },
};
