import type { Session } from '@remote-control/protocol';

import type { AgentAdapterId } from '../ports/agent-adapter.js';
import type { Clock } from '../ports/clock.js';
import type { ClaudeCli, RosterEntry } from '../ports/claude-cli.js';
import type { Timer, TimerHandle } from '../ports/timer.js';

/** How often the roster is re-read while any session is known (04 §5.3). */
export const ROSTER_POLL_MS = 10_000;
/** A session nothing reported for this long leaves the registry (04 §5.3). */
export const SESSION_STALE_MS = 24 * 60 * 60_000;

/** One session as the registry knows it. */
export interface RegistrySession {
  readonly id: string;
  readonly cwd: string;
  /** The agent whose hooks name the session (M2-01). */
  readonly agent: AgentAdapterId;
  readonly name: string | undefined;
  /** `undefined` until the roster has reported the session. */
  readonly kind: RosterEntry['kind'] | undefined;
  readonly state: Session['state'];
  /** Unix epoch ms of the last hook or live roster row. */
  readonly seenAt: number;
}

export interface SessionRegistryOptions {
  readonly clock: Clock;
  readonly timer: Timer;
  readonly cli: Pick<ClaudeCli, 'agents'>;
  /** Something a phone shows changed: a session came, went or changed state. */
  readonly onChange?: () => void;
  readonly pollMs?: number;
  readonly staleMs?: number;
}

/**
 * The sessions on this machine (04 §5.3), from two sources: every hook names its
 * session and folder, and `claude agents --json --all` adds the name, the kind and the
 * state. The roster is re-read every 10 s while any session is known; a session silent
 * for 24 h is dropped.
 */
export interface SessionRegistry {
  /**
   * A hook from `sessionId` in `cwd`; `ended` for `SessionEnd`. `agent` defaults to
   * `claude-code`; only Claude Code hooks mark `cwd` as seen (`seenCwd`).
   */
  observe(sessionId: string, cwd: string, ended: boolean, agent?: AgentAdapterId): void;
  /** Re-reads the roster now; `undefined` when the CLI could not be read. */
  refresh(): Promise<readonly RosterEntry[] | undefined>;
  list(): readonly RegistrySession[];
  get(sessionId: string): RegistrySession | undefined;
  /**
   * A hook ever came from `cwd`: Claude Code runs hooks there, so the folder is trusted
   * and has remotectl's hooks. Lexical; the caller passes canonical paths.
   */
  seenCwd(cwd: string): boolean;
  /** Stops polling. */
  close(): void;
}

function rosterState(entry: RosterEntry): Session['state'] {
  if (entry.state === 'blocked') return 'waiting';
  if (entry.state !== 'working') return 'ended';
  if (entry.status === 'waiting') return 'waiting';
  return entry.status === 'idle' ? 'idle' : 'working';
}

export function createSessionRegistry(options: SessionRegistryOptions): SessionRegistry {
  const { clock, timer } = options;
  const pollMs = options.pollMs ?? ROSTER_POLL_MS;
  const staleMs = options.staleMs ?? SESSION_STALE_MS;
  const sessions = new Map<string, RegistrySession>();
  const cwds = new Set<string>();
  let poll: TimerHandle | undefined;
  let closed = false;

  function prune(): boolean {
    const cutoff = clock.now() - staleMs;
    let changed = false;
    for (const [id, session] of sessions) {
      if (session.seenAt > cutoff) continue;
      sessions.delete(id);
      changed = true;
    }
    return changed;
  }

  function put(next: RegistrySession): boolean {
    const previous = sessions.get(next.id);
    sessions.set(next.id, next);
    return (
      previous === undefined ||
      previous.state !== next.state ||
      previous.name !== next.name ||
      previous.kind !== next.kind ||
      previous.agent !== next.agent ||
      previous.cwd !== next.cwd
    );
  }

  function schedule(): void {
    if (closed || poll !== undefined || sessions.size === 0) return;
    poll = timer.after(pollMs, () => {
      poll = undefined;
      void registry.refresh().finally(schedule);
    });
  }

  function merge(entries: readonly RosterEntry[]): boolean {
    const now = clock.now();
    let changed = false;
    for (const entry of entries) {
      const state = rosterState(entry);
      const known = sessions.get(entry.sessionId);
      // The roster lists every past session; only live ones or known ones are news.
      if (known === undefined && state === 'ended') continue;
      const seenAt = state === 'ended' && known !== undefined ? known.seenAt : now;
      changed =
        put({
          id: entry.sessionId,
          cwd: entry.cwd,
          agent: known?.agent ?? 'claude-code',
          name: entry.name ?? known?.name,
          kind: entry.kind,
          state,
          seenAt,
        }) || changed;
    }
    return changed;
  }

  const registry: SessionRegistry = {
    observe(sessionId, cwd, ended, agent = 'claude-code') {
      if (agent === 'claude-code') cwds.add(cwd);
      const known = sessions.get(sessionId);
      const changed = put({
        id: sessionId,
        cwd,
        agent,
        name: known?.name,
        kind: known?.kind,
        state: ended
          ? 'ended'
          : known === undefined || known.state === 'ended'
            ? 'working'
            : known.state,
        seenAt: clock.now(),
      });
      if (changed) options.onChange?.();
      schedule();
    },
    async refresh() {
      const entries = await options.cli.agents();
      const changed = (entries !== undefined && merge(entries)) || prune();
      if (changed) options.onChange?.();
      schedule();
      return entries;
    },
    list() {
      if (prune()) options.onChange?.();
      return [...sessions.values()];
    },
    get(sessionId) {
      return sessions.get(sessionId);
    },
    seenCwd(cwd) {
      return cwds.has(cwd);
    },
    close() {
      closed = true;
      poll?.cancel();
      poll = undefined;
    },
  };
  return registry;
}
