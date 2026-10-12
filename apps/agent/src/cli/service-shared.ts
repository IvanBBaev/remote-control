// Pieces shared by the launchd, systemd and Task Scheduler installers (D22, 06 §5.4).
import { posix } from 'node:path';

import { installLocationProblem } from '../core/install-location-problem.js';
import type { Container } from '../container.js';
import type { ProcessResult } from '../ports/process-result.js';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
/** The exit code a shell reports for a command it could not start. */
const EXIT_NOT_STARTED = 127;

export interface ServiceOptions {
  /** Print what would happen and touch nothing (no files, no service manager calls). */
  readonly dryRun: boolean;
}

/** The service `PATH` (POSIX): the installing shell's, with the Node binary's directory first. */
export function servicePath(c: Container, fallback: string): string {
  const nodeDir = posix.dirname(c.service.execPath);
  const entries = (c.service.pathEnv ?? fallback).split(':').filter((entry) => entry !== '');
  return [nodeDir, ...entries.filter((entry) => entry !== nodeDir)].join(':');
}

export type ResolvedScript = { ok: true; scriptPath: string } | { ok: false; message: string };

/** The real path of the running CLI, refused when it is not a stable global install. */
export async function resolveScript(c: Container): Promise<ResolvedScript> {
  const invoked = c.service.scriptPath;
  const real = invoked === undefined ? undefined : await c.pathPort.realpath(invoked);
  if (real === undefined) {
    return { ok: false, message: 'cannot locate the remotectl entry script' };
  }
  const tmp = (await c.pathPort.realpath(c.service.tmpdir)) ?? c.service.tmpdir;
  const problem = installLocationProblem(real, tmp);
  if (problem !== undefined) {
    return {
      ok: false,
      message:
        `${problem} (${real}), which can disappear at any time, so a service cannot point ` +
        'at it.\nInstall remotectl globally first, then install the service from there:\n' +
        '  npm install -g remotectl\n  remotectl install',
    };
  }
  return { ok: true, scriptPath: real };
}

/**
 * Runs a service-manager call and turns a failure to start it (the binary is missing,
 * e.g. no systemd) into a result with exit code 127, so callers report it like any
 * other failed command. Argument errors are bugs and still throw.
 */
export async function attempt(call: () => Promise<ProcessResult>): Promise<ProcessResult> {
  try {
    return await call();
  } catch (error) {
    if (typeof (error as NodeJS.ErrnoException).code !== 'string') throw error;
    return { code: EXIT_NOT_STARTED, stdout: '', stderr: (error as Error).message };
  }
}

/** The first non-empty line of a command's error output, for one-line messages. */
export function firstLine(result: ProcessResult): string {
  const text = result.stderr.trim() || result.stdout.trim();
  return text.split('\n')[0]?.trim() || `exit ${result.code}`;
}
