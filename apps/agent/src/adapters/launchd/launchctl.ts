// The second and last module in the agent allowed to import child_process (D13, D22).
// It runs only the literal `/bin/launchctl` binary, never a shell, and every argv comes
// from an `...Argv` builder that returns an array literal; `scripts/check-argv-policy.mjs`
// enforces all three rules for this file.
import { spawn } from 'node:child_process';

import type { Launchctl, LaunchctlResult } from '../../ports/launchctl.js';

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

/** The subset of `ChildProcess` that `collect` reads; tests pass an `EventEmitter`. */
export interface CollectableProcess {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown;
}

/** Gathers a child's output and resolves with its exit code once it closes. */
export function collect(child: CollectableProcess): Promise<LaunchctlResult> {
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => (stdout += chunk));
  child.stderr?.on('data', (chunk: string) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) =>
      resolve({ code: code ?? (signal === null ? 1 : 128), stdout, stderr }),
    );
  });
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
