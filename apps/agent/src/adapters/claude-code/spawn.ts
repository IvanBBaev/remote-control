// The only module in the agent allowed to import child_process (D13, 02 W11). Its argv
// builders return array literals; `scripts/check-argv-policy.mjs` enforces both rules.
import { spawn } from 'node:child_process';

import type { ResolveRepositoryResult } from '../../core/resolve-repository.js';
import type { ProcessResult } from '../../ports/process-result.js';
import { collect } from '../process-collect.js';

const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A Claude Code session id as `agents --json` and the hooks report it: a UUID. */
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PROMPT_LENGTH = 32_768;
/** `agents --json` and `--version` answer at once; a hung CLI is killed after this. */
const QUERY_TIMEOUT_MS = 15_000;

/** The environment every `claude` child gets; `undefined` entries are left out. */
export type ClaudeEnv = Readonly<Record<string, string | undefined>>;

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

function checkSessionId(sessionId: string): string {
  if (!SESSION_UUID.test(sessionId)) throw new SpawnArgumentError('invalid session id');
  return sessionId;
}

/** `claude --bg --name <name> <prompt>` (D11): the start argv, literal and complete. */
export function startSessionArgv(name: string, prompt: string): string[] {
  return ['--bg', '--name', checkName(name), checkPrompt(prompt)];
}

/** `claude --resume <uuid> --bg <prompt>` (04 §5.4): a follow-up to a background session. */
export function resumeSessionArgv(sessionId: string, prompt: string): string[] {
  return ['--resume', checkSessionId(sessionId), '--bg', checkPrompt(prompt)];
}

/** `claude agents --json --all` (04 §5.3): the session roster, ended sessions included. */
export function agentsArgv(): string[] {
  return ['agents', '--json', '--all'];
}

/** `claude --version` (04 §5.4): the follow-up version gate. */
export function versionArgv(): string[] {
  return ['--version'];
}

export interface SpawnBackgroundSessionOptions {
  /** The `claude` executable (absolute path resolved by the adapter). */
  readonly command: string;
  /** Only an allow-listed repository can be a working directory. */
  readonly repository: Extract<ResolveRepositoryResult, { allowed: true }>;
  readonly name: string;
  readonly prompt: string;
  readonly env: ClaudeEnv;
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
      env: options.env,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
  });
}

export interface ResumeBackgroundSessionOptions {
  readonly command: string;
  /** The session's folder, still on the allow-list. */
  readonly repository: Extract<ResolveRepositoryResult, { allowed: true }>;
  /** The background session's UUID, from `agents --json` or its hooks. */
  readonly sessionId: string;
  readonly prompt: string;
  readonly env: ClaudeEnv;
}

/**
 * Sends a follow-up prompt to a background session (`--resume <uuid> --bg`) and resolves
 * with the CLI's exit code. Invalid arguments throw `SpawnArgumentError` synchronously.
 */
export function resumeBackgroundSession(options: ResumeBackgroundSessionOptions): Promise<number> {
  const argv = resumeSessionArgv(options.sessionId, options.prompt);
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, argv, {
      cwd: options.repository.realPath,
      env: options.env,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
  });
}

/** Runs `claude agents --json --all` and resolves with its output, unparsed. */
export function listAgents(command: string, env: ClaudeEnv): Promise<ProcessResult> {
  const argv = agentsArgv();
  return collect(
    spawn(command, argv, {
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: QUERY_TIMEOUT_MS,
      windowsHide: true,
    }),
  );
}

/** Runs `claude --version` and resolves with its output, unparsed. */
export function claudeVersion(command: string, env: ClaudeEnv): Promise<ProcessResult> {
  const argv = versionArgv();
  return collect(
    spawn(command, argv, {
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: QUERY_TIMEOUT_MS,
      windowsHide: true,
    }),
  );
}
