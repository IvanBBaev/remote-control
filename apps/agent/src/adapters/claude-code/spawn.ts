// The only module in the agent allowed to import child_process (D13, 02 W11). Its argv
// builders return array literals; `scripts/check-argv-policy.mjs` enforces both rules.
import { spawn } from 'node:child_process';

import type { ResolveRepositoryResult } from '../../core/resolve-repository.js';

const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_PROMPT_LENGTH = 32_768;

/** A spawn argument was refused before any process started. */
export class SpawnArgumentError extends Error {
  override readonly name = 'SpawnArgumentError';
}

function checkName(name: string): string {
  if (!SESSION_NAME.test(name)) throw new SpawnArgumentError('invalid session name');
  return name;
}

/**
 * A prompt travels as one argv element (no shell). One starting with `-` would be parsed
 * by the CLI as an option, so it is refused rather than rewritten.
 */
function checkPrompt(prompt: string): string {
  if (prompt.length === 0 || prompt.length > MAX_PROMPT_LENGTH) {
    throw new SpawnArgumentError('prompt must be 1..32768 characters');
  }
  if (prompt.startsWith('-')) throw new SpawnArgumentError('prompt must not start with "-"');
  if (prompt.includes('\0')) throw new SpawnArgumentError('prompt must not contain NUL');
  return prompt;
}

/** `claude --bg --name <name> <prompt>` (D11): the start argv, literal and complete. */
export function startSessionArgv(name: string, prompt: string): string[] {
  return ['--bg', '--name', checkName(name), checkPrompt(prompt)];
}

export interface SpawnBackgroundSessionOptions {
  /** The `claude` executable (absolute path resolved by the adapter). */
  readonly command: string;
  /** Only an allow-listed repository can be a working directory. */
  readonly repository: Extract<ResolveRepositoryResult, { allowed: true }>;
  readonly name: string;
  readonly prompt: string;
}

/**
 * Starts a background session in an allow-listed repository and resolves with the CLI's
 * exit code (`claude --bg` returns once the session is detached). No shell is involved,
 * and nothing from the phone can add an argument. Invalid arguments throw
 * `SpawnArgumentError` synchronously.
 */
export function spawnBackgroundSession(options: SpawnBackgroundSessionOptions): Promise<number> {
  const argv = startSessionArgv(options.name, options.prompt);
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, argv, {
      cwd: options.repository.realPath,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
  });
}
