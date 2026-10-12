// One of the process modules allowed to import child_process (D13, D22).
// It runs only the literal `/bin/launchctl` binary, never a shell, and every argv comes
// from an `...Argv` builder that returns an array literal; `scripts/check-argv-policy.mjs`
// enforces all three rules for this file.
import { spawn } from 'node:child_process';

import type { Launchctl } from '../../ports/launchctl.js';
import { collect } from '../process-collect.js';

const DOMAIN = /^gui\/\d+$/;
const SERVICE_TARGET = /^gui\/\d+\/[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/;

/** A launchctl argument was refused before any process started. */
export class LaunchctlArgumentError extends Error {
  override readonly name = 'LaunchctlArgumentError';
}

function checkDomain(domain: string): string {
  if (!DOMAIN.test(domain)) throw new LaunchctlArgumentError('invalid launchd domain');
  return domain;
}

function checkServiceTarget(target: string): string {
  if (!SERVICE_TARGET.test(target)) throw new LaunchctlArgumentError('invalid service target');
  return target;
}

function checkPlistPath(path: string): string {
  if (!path.startsWith('/') || !path.endsWith('.plist') || path.includes('\0')) {
    throw new LaunchctlArgumentError('plist path must be an absolute .plist path');
  }
  return path;
}

/** `launchctl bootstrap gui/<uid> <plist>`. */
export function bootstrapArgv(domain: string, plistPath: string): string[] {
  return ['bootstrap', checkDomain(domain), checkPlistPath(plistPath)];
}

/** `launchctl bootout gui/<uid>/<label>`. */
export function bootoutArgv(serviceTarget: string): string[] {
  return ['bootout', checkServiceTarget(serviceTarget)];
}

/** `launchctl print gui/<uid>/<label>`. */
export function printArgv(serviceTarget: string): string[] {
  return ['print', checkServiceTarget(serviceTarget)];
}

/** `Launchctl` over the real `/bin/launchctl` (macOS only). */
export const systemLaunchctl: Launchctl = {
  bootstrap(domain, plistPath) {
    const argv = bootstrapArgv(domain, plistPath);
    return collect(
      spawn('/bin/launchctl', argv, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  },
  bootout(serviceTarget) {
    const argv = bootoutArgv(serviceTarget);
    return collect(
      spawn('/bin/launchctl', argv, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  },
  print(serviceTarget) {
    const argv = printArgv(serviceTarget);
    return collect(
      spawn('/bin/launchctl', argv, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  },
};
