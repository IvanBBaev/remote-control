import type { PermissionMode } from '@remote-control/protocol';

import type { ResolveRepositoryResult } from '../core/resolve-repository.js';

/** An allow-listed folder, already resolved (02 §4.1); the only possible working directory. */
export type AllowedRepository = Extract<ResolveRepositoryResult, { allowed: true }>;

/** One row of `claude agents --json` (04 §2.8), reduced to what the registry reads. */
export interface RosterEntry {
  readonly sessionId: string;
  readonly cwd: string;
  readonly kind: 'interactive' | 'background';
  readonly state: 'working' | 'blocked' | 'done' | 'failed' | 'stopped';
  /** `undefined` when the CLI left it out or sent a value this agent does not know. */
  readonly status: 'busy' | 'waiting' | 'idle' | undefined;
  readonly name: string | undefined;
}

/**
 * The Claude Code CLI as the launcher and the session registry use it (04 §5.3, §5.4).
 * Every call spawns `claude` without a shell and with a literal argv (D13).
 */
export interface ClaudeCli {
  /** `claude --version`'s semantic version; `undefined` when it cannot be read. */
  version(): Promise<string | undefined>;
  /** The session roster; `undefined` when the CLI failed or printed something else. */
  agents(): Promise<readonly RosterEntry[] | undefined>;
  /**
   * `claude --bg --name <name> <prompt>` in `repository`, naming the permission mode when
   * it is not the default (M2-09); resolves with the exit code.
   */
  start(
    repository: AllowedRepository,
    name: string,
    prompt: string,
    permissionMode?: PermissionMode,
  ): Promise<number>;
  /** `claude --resume <uuid> --bg <prompt>` in `repository`; resolves with the exit code. */
  resume(repository: AllowedRepository, sessionId: string, prompt: string): Promise<number>;
}
