import { setTimeout as sleep } from 'node:timers/promises';

/** Windows reports a file another process has open (a scanner, a reader, a script host) like this. */
const WINDOWS_BUSY_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'EACCES']);

/** True for a Windows "file in use" error; always false on other platforms. */
export function isWindowsBusy(error: unknown, platform: string = process.platform): boolean {
  if (platform !== 'win32') return false;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && WINDOWS_BUSY_CODES.has(code);
}

export interface RetryOptions {
  readonly attempts: number;
  readonly delayMs: number;
  readonly isTransient: (error: unknown) => boolean;
}

/**
 * Runs `op`, retrying after `delayMs` while it throws a transient error, at most `attempts`
 * times in all. The last error is rethrown, so a persistent failure still surfaces.
 */
export async function retryTransient<T>(op: () => Promise<T>, options: RetryOptions): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await op();
    } catch (error) {
      if (attempt >= options.attempts || !options.isTransient(error)) throw error;
      await sleep(options.delayMs);
    }
  }
}

/** The retry policy for fs calls that can race another process's open handle on Windows. */
export const WINDOWS_BUSY_RETRY: RetryOptions = {
  attempts: 20,
  delayMs: 50,
  isTransient: (error) => isWindowsBusy(error),
};
