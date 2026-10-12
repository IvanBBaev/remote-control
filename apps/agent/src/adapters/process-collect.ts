import type { ProcessResult } from '../ports/process-result.js';

/** The subset of `ChildProcess` that `collect` reads; tests pass an `EventEmitter`. */
export interface CollectableProcess {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown;
}

/**
 * Gathers a child's output and resolves with its exit code once it closes. Shared by the
 * process modules; it never starts a process itself (no `child_process` import here).
 */
export function collect(child: CollectableProcess): Promise<ProcessResult> {
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
