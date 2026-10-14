import {
  permissionModeWithin,
  toHex,
  type PermissionMode,
  type Repository,
  type Session,
} from '@remote-control/protocol';

import type { AgentAdapterId } from '../ports/agent-adapter.js';
import type { ClaudeCli } from '../ports/claude-cli.js';
import type { PathPort } from '../ports/path-port.js';
import type { Random } from '../ports/random.js';
import type { RepositoryEntry } from './agent-config.js';
import { resolveRepository } from './resolve-repository.js';
import type { SessionRegistry } from './session-registry.js';

/** `claude --resume <uuid> --bg` keeps the session id from this version on (04 §2.8). */
export const FOLLOW_UP_MIN_VERSION = '2.1.257';

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PROJECT_IN_NAME = 40;

/** A repository as the phone sees it; `machineId` is the hub's to add. */
export type RepositoryView = Omit<Repository, 'machineId'> & {
  readonly maxPermissionMode: PermissionMode;
};

/** A session as the phone sees it, before the hub adds the machine. */
export type SessionView = Pick<Session, 'id' | 'repositoryId' | 'state' | 'statusText'> & {
  /** The agent running the session; absent means `claude-code` (M2-01). */
  readonly agent?: AgentAdapterId;
  readonly name: string | null;
  readonly followUp: boolean;
};

export type LaunchRefusal = 'not_allowed' | 'start_failed' | 'follow_up_unsupported';

export type LaunchResult =
  | { readonly ok: true; readonly sessionId?: string }
  | { readonly ok: false; readonly reason: LaunchRefusal };

/** What the session hub needs to start sessions and send follow-ups (M1-04). */
export interface SessionLauncher {
  repositories(): Promise<readonly RepositoryView[]>;
  sessions(): Promise<readonly SessionView[]>;
  /** Whether `sessionId` takes a follow-up now (background, known UUID, allowed folder). */
  canFollowUp(sessionId: string): Promise<boolean>;
  /** `permissionMode` left out: the CLI's default mode. */
  start(
    repositoryId: string,
    prompt: string,
    permissionMode?: PermissionMode,
  ): Promise<LaunchResult>;
  instruct(sessionId: string, text: string): Promise<LaunchResult>;
}

/** Audit events: names, ids and codes only, never a prompt or a path (I3). */
export type LauncherLog = (event: string, fields: Readonly<Record<string, unknown>>) => void;

export interface LauncherOptions {
  /** `repositories` from the config: the allow-list and its mode bounds (02 §4.1, D13). */
  readonly repositories: readonly RepositoryEntry[];
  readonly paths: PathPort;
  readonly cli: ClaudeCli;
  readonly registry: SessionRegistry;
  readonly random: Random;
  /** The CLI passed the follow-up version gate (`FOLLOW_UP_MIN_VERSION`). */
  readonly followUps: boolean;
  readonly log?: LauncherLog;
}

/** `a.b.c` ≥ `min`; anything unparsable is not. */
export function versionAtLeast(version: string | undefined, min: string): boolean {
  const parse = (text: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(text)?.slice(1).map(Number);
  const have = version === undefined ? undefined : parse(version);
  const need = parse(min)!;
  if (have === undefined) return false;
  for (let i = 0; i < 3; i += 1) {
    if (have[i]! !== need[i]!) return have[i]! > need[i]!;
  }
  return true;
}

/** The repository id: the first 32 hex digits of SHA-256 over the configured root. */
export async function repositoryId(root: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(root));
  return toHex(new Uint8Array(digest)).slice(0, 32);
}

/** The last path segment, for display; either separator counts. */
export function folderName(root: string): string {
  const parts = root.split(/[\\/]+/).filter((part) => part.length > 0);
  return parts.at(-1) ?? root;
}

/** `rc-<project>-<8 hex>`: a name `startSessionArgv` accepts, unique enough to find again. */
export function sessionName(project: string, random: Random): string {
  const safe = project.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, MAX_PROJECT_IN_NAME);
  return `rc-${safe.length === 0 ? 'repo' : safe}-${toHex(random.bytes(4))}`;
}

const STATUS_TEXT: Readonly<Record<Session['state'], string>> = {
  starting: 'Starting',
  working: 'Working',
  waiting: 'Waiting for input',
  idle: 'Idle',
  ended: 'Ended',
};

/**
 * Starts sessions and sends follow-ups (D11, D13, 04 §5.4): only in an allow-listed
 * repository, re-resolved at every launch, and only with the literal argv of the spawn
 * module. A refusal is logged before anything is spawned.
 */
export function createLauncher(options: LauncherOptions): SessionLauncher {
  const { cli, registry, paths } = options;
  const log: LauncherLog = options.log ?? (() => undefined);
  const roots = options.repositories.map((entry) => entry.path);
  let catalog: Promise<readonly RepositoryView[]> | undefined;

  function repositories(): Promise<readonly RepositoryView[]> {
    catalog ??= Promise.all(
      options.repositories.map(async ({ path, maxPermissionMode }) => ({
        id: await repositoryId(path),
        name: folderName(path).slice(0, 128),
        path,
        maxPermissionMode,
      })),
    );
    return catalog;
  }

  /** The repository a canonical `cwd` lies in, for display; `null` outside all of them. */
  async function repositoryOf(cwd: string): Promise<string | null> {
    for (const repository of await repositories()) {
      const real = await paths.realpath(repository.path);
      if (real !== undefined && paths.contains(real, cwd)) return repository.id;
    }
    return null;
  }

  /** The session's folder when it is still on the allow-list. */
  async function followUpTarget(sessionId: string) {
    const session = registry.get(sessionId);
    // Only Claude Code background sessions take a follow-up; Codex and Gemini have none.
    if (
      !options.followUps ||
      session === undefined ||
      session.agent !== 'claude-code' ||
      session.kind !== 'background'
    ) {
      return undefined;
    }
    if (!SESSION_UUID.test(sessionId)) return undefined;
    const resolved = await resolveRepository(roots, session.cwd, paths);
    return resolved.allowed ? resolved : undefined;
  }

  return {
    repositories,
    async sessions() {
      const views: SessionView[] = [];
      for (const session of registry.list()) {
        views.push({
          id: session.id,
          agent: session.agent,
          repositoryId: await repositoryOf(session.cwd),
          state: session.state,
          statusText: STATUS_TEXT[session.state],
          name: session.name ?? null,
          followUp: session.state !== 'ended' && (await followUpTarget(session.id)) !== undefined,
        });
      }
      return views;
    },
    async canFollowUp(sessionId) {
      return (await followUpTarget(sessionId)) !== undefined;
    },
    async start(id, prompt, permissionMode) {
      const repository = (await repositories()).find((candidate) => candidate.id === id);
      const resolved =
        repository === undefined
          ? undefined
          : await resolveRepository(roots, repository.path, paths);
      if (repository === undefined || resolved === undefined || !resolved.allowed) {
        log('launch_refused', {
          repository_id: id,
          reason: resolved?.allowed === false ? resolved.reason : 'unknown_repository',
        });
        return { ok: false, reason: 'not_allowed' };
      }
      // The bound is the agent's, never the phone's (M2-09): checked before any spawn. No
      // mode is the default mode, which a `plan`-bound folder refuses too.
      if (!permissionModeWithin(permissionMode ?? 'default', repository.maxPermissionMode)) {
        log('launch_refused', { repository_id: id, reason: 'permission_mode_above_bound' });
        return { ok: false, reason: 'not_allowed' };
      }
      // A folder no hook ever came from may be untrusted or lack the hooks (04 §2.8).
      if (!registry.seenCwd(resolved.realPath)) {
        log('launch_trust_unknown', { repository_id: id });
      }
      const name = sessionName(repository.name, options.random);
      let code: number;
      try {
        code = await cli.start(resolved, name, prompt, permissionMode);
      } catch (error) {
        log('launch_failed', {
          repository_id: id,
          error: error instanceof Error ? error.name : 'unknown',
        });
        return { ok: false, reason: 'start_failed' };
      }
      if (code !== 0) {
        log('launch_failed', { repository_id: id, exit_code: code });
        return { ok: false, reason: 'start_failed' };
      }
      const roster = await registry.refresh();
      const entry = roster?.find((row) => row.name === name && row.cwd === resolved.realPath);
      log('launch_started', { repository_id: id, session_id: entry?.sessionId ?? null });
      return entry === undefined ? { ok: true } : { ok: true, sessionId: entry.sessionId };
    },
    async instruct(sessionId, text) {
      const target = await followUpTarget(sessionId);
      if (target === undefined) {
        log('instruct_refused', { session_id: sessionId });
        return { ok: false, reason: 'follow_up_unsupported' };
      }
      let code: number;
      try {
        code = await cli.resume(target, sessionId, text);
      } catch (error) {
        log('instruct_failed', {
          session_id: sessionId,
          error: error instanceof Error ? error.name : 'unknown',
        });
        return { ok: false, reason: 'start_failed' };
      }
      if (code !== 0) {
        log('instruct_failed', { session_id: sessionId, exit_code: code });
        return { ok: false, reason: 'start_failed' };
      }
      log('instruct_sent', { session_id: sessionId });
      await registry.refresh();
      return { ok: true, sessionId };
    },
  };
}
