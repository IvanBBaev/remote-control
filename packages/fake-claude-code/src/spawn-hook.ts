import { type ChildProcess, spawn } from 'node:child_process';

import type { Env } from './paths.js';

export interface SpawnHookOptions {
  readonly command: string;
  readonly stdin: string;
  readonly cwd: string;
  readonly env: Env;
  readonly timeoutMs: number;
}

export interface SpawnHookResult {
  /** `null` when the process was killed (timeout) or never started. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** Set when the command could not be started at all. */
  readonly spawnError?: string;
}

const isWindows = process.platform === 'win32';

/** Kills the hook and anything it started (the shell may leave its child running). */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (isWindows) {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/**
 * Runs one `command` hook: the command string goes to the platform shell (`/bin/sh -c`
 * on POSIX, `cmd.exe /d /s /c` on Windows) with the event JSON on stdin.
 * Assumption: 04 §2 does not say which shell Claude Code uses on Windows (it may be Git
 * Bash); commands written as `"<node>" "<script>"` behave the same under every shell.
 * On timeout the whole process tree is killed and the result is returned at once.
 */
export function spawnHook(options: SpawnHookOptions): Promise<SpawnHookResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: SpawnHookResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(options.command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      // A process group of its own lets a timeout kill the shell and its children.
      detached: !isWindows,
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      killTree(child);
      finish({ exitCode: null, stdout, stderr, timedOut: true });
    }, options.timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error) => {
      finish({ exitCode: null, stdout, stderr, timedOut: false, spawnError: error.message });
    });
    child.on('close', (code) => {
      finish({ exitCode: code, stdout, stderr, timedOut: false });
    });
    // A hook may exit without reading stdin; the resulting EPIPE is not an error.
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.stdin);
  });
}
