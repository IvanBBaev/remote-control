// One of the process modules allowed to import child_process (D13, D22, M1-08).
// It runs only the literal `C:\Windows\System32\schtasks.exe`, never a shell, and every
// argv comes from an `...Argv` builder that returns an array literal;
// `scripts/check-argv-policy.mjs` enforces all three rules for this file.
import { spawn } from 'node:child_process';

import type { Schtasks } from '../../ports/schtasks.js';
import { collect } from '../process-collect.js';

/** The only task the agent ever manages. */
const TASK = 'remotectl';
/** A drive-absolute Windows path to an `.xml` file, without quotes or control characters. */
// eslint-disable-next-line no-control-regex
const XML_PATH = /^[A-Za-z]:\\[^"\u0000-\u001F]*\.xml$/i;

/** A schtasks argument was refused before any process started. */
export class SchtasksArgumentError extends Error {
  override readonly name = 'SchtasksArgumentError';
}

function checkTask(task: string): string {
  if (task !== TASK) throw new SchtasksArgumentError(`task name must be ${TASK}`);
  return task;
}

function checkXmlPath(path: string): string {
  if (!XML_PATH.test(path)) {
    throw new SchtasksArgumentError('task XML path must be an absolute Windows .xml path');
  }
  return path;
}

/** `schtasks /Create /TN remotectl /XML <path> /F`. */
export function createArgv(task: string, xmlPath: string): string[] {
  return ['/Create', '/TN', checkTask(task), '/XML', checkXmlPath(xmlPath), '/F'];
}

/** `schtasks /Delete /TN remotectl /F`. */
export function deleteArgv(task: string): string[] {
  return ['/Delete', '/TN', checkTask(task), '/F'];
}

/** `schtasks /Query /TN remotectl /XML ONE`. */
export function queryArgv(task: string): string[] {
  return ['/Query', '/TN', checkTask(task), '/XML', 'ONE'];
}

/** `schtasks /Run /TN remotectl`. */
export function runArgv(task: string): string[] {
  return ['/Run', '/TN', checkTask(task)];
}

/** `schtasks /End /TN remotectl`. */
export function endArgv(task: string): string[] {
  return ['/End', '/TN', checkTask(task)];
}

/** `Schtasks` over the real `schtasks.exe` (Windows only). */
export const systemSchtasks: Schtasks = {
  create(task, xmlPath) {
    const argv = createArgv(task, xmlPath);
    return collect(
      spawn('C:\\Windows\\System32\\schtasks.exe', argv, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  },
  delete(task) {
    const argv = deleteArgv(task);
    return collect(
      spawn('C:\\Windows\\System32\\schtasks.exe', argv, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  },
  query(task) {
    const argv = queryArgv(task);
    return collect(
      spawn('C:\\Windows\\System32\\schtasks.exe', argv, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  },
  run(task) {
    const argv = runArgv(task);
    return collect(
      spawn('C:\\Windows\\System32\\schtasks.exe', argv, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  },
  end(task) {
    const argv = endArgv(task);
    return collect(
      spawn('C:\\Windows\\System32\\schtasks.exe', argv, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  },
};
