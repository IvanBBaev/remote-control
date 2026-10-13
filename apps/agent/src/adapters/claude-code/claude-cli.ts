import type { ClaudeCli, RosterEntry } from '../../ports/claude-cli.js';
import {
  claudeVersion,
  listAgents,
  resumeBackgroundSession,
  spawnBackgroundSession,
  type ClaudeEnv,
} from './spawn.js';

const VERSION = /^(\d+\.\d+\.\d+)\b/;
const KINDS = new Set(['interactive', 'background']);
const STATES = new Set(['working', 'blocked', 'done', 'failed', 'stopped']);
const STATUSES = new Set(['busy', 'waiting', 'idle']);
/** Session names this agent can match against; longer or odd ones are dropped. */
const MAX_NAME_LENGTH = 64;

/** `2.1.300 (Claude Code)` → `2.1.300`; `undefined` for anything else. */
export function parseClaudeVersion(stdout: string): string | undefined {
  return VERSION.exec(stdout.trim())?.[1];
}

function rosterEntry(value: unknown): RosterEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const row = value as Record<string, unknown>;
  const { sessionId, cwd, kind, state, status, name } = row;
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128) {
    return undefined;
  }
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined;
  if (typeof kind !== 'string' || !KINDS.has(kind)) return undefined;
  if (typeof state !== 'string' || !STATES.has(state)) return undefined;
  return {
    sessionId,
    cwd,
    kind: kind as RosterEntry['kind'],
    state: state as RosterEntry['state'],
    status:
      typeof status === 'string' && STATUSES.has(status)
        ? (status as RosterEntry['status'])
        : undefined,
    name:
      typeof name === 'string' && name.length > 0 && name.length <= MAX_NAME_LENGTH
        ? name
        : undefined,
  };
}

/**
 * `claude agents --json` output → roster rows. 04 §2.8 calls the format "not a stable
 * interface", so every row is checked and an unreadable one is skipped; output that is
 * not a JSON array at all is `undefined`.
 */
export function parseRoster(stdout: string): RosterEntry[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  return parsed.map(rosterEntry).filter((entry) => entry !== undefined);
}

export interface ClaudeCliOptions {
  /** The `claude` executable, found on `PATH` by the operating system. */
  readonly command: string;
  readonly env: ClaudeEnv;
}

/** The `ClaudeCli` port over the spawn module (D13: no shell, literal argv). */
export function createClaudeCli(options: ClaudeCliOptions): ClaudeCli {
  const { command, env } = options;
  return {
    async version() {
      try {
        const result = await claudeVersion(command, env);
        return result.code === 0 ? parseClaudeVersion(result.stdout) : undefined;
      } catch {
        return undefined;
      }
    },
    async agents() {
      try {
        const result = await listAgents(command, env);
        return result.code === 0 ? parseRoster(result.stdout) : undefined;
      } catch {
        return undefined;
      }
    },
    start: (repository, name, prompt, permissionMode) =>
      spawnBackgroundSession({
        command,
        repository,
        name,
        prompt,
        env,
        ...(permissionMode === undefined ? {} : { permissionMode }),
      }),
    resume: (repository, sessionId, prompt) =>
      resumeBackgroundSession({ command, repository, sessionId, prompt, env }),
  };
}
