import type { AgentAdapterId } from '../ports/agent-adapter.js';
import type { Clock } from '../ports/clock.js';
import type { Random } from '../ports/random.js';
import type { Timer, TimerHandle } from '../ports/timer.js';
import { uuidV4 } from './uuid.js';

/** The pending store answers `DEADLINE_MARGIN_MS` before the hook's own timeout (D10). */
export const DEADLINE_MARGIN_MS = 10_000;
/** A repeat of the same request within this window is a duplicate (same id). */
export const DUPLICATE_WINDOW_MS = 2_000;
/** How many ended ids are remembered to reject late and second decisions. */
export const RELEASED_MEMORY = 1_000;

/** `permission` = `PermissionRequest`; `question` = `PreToolUse` for `AskUserQuestion`. */
export type PendingKind = 'permission' | 'question';

/** Why a request ended without a decision; every one of them means "terminal decides". */
export type HandoffReason =
  /** The deadline `T − 10 s` passed (D10). */
  | 'deadline'
  /** A newer request for the same session and kind took its place. */
  | 'replaced'
  /** Released early (the phone's "Reply in terminal", 01 W9). */
  | 'released'
  /** `remotectl pause` while the request was held (M1-03). */
  | 'paused'
  /** The hook process went away (Claude Code killed it or the user answered locally). */
  | 'disconnected'
  /** The agent is stopping. */
  | 'shutdown';

/**
 * How a pending request ended. `decided` carries the hook output built elsewhere (the
 * adapter's `decide`, from a phone decision); the store itself never produces one, so the
 * agent can never grant on its own (§1, D10).
 */
export type PendingOutcome =
  | { readonly type: 'decided'; readonly response: Readonly<Record<string, unknown>> }
  | { readonly type: 'handoff'; readonly reason: HandoffReason };

export interface PendingRequest {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: PendingKind;
  /** Identity of the request content (tool name + input); equal fingerprints are duplicates. */
  readonly fingerprint: string;
  /** The hook input as received. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** Unix epoch milliseconds. */
  readonly createdAt: number;
  /** Unix epoch milliseconds: `createdAt + T − 10 s`. */
  readonly deadline: number;
  /** The agent whose hook is held; absent means `claude-code` (M2-01). */
  readonly agent?: AgentAdapterId;
}

export interface RegisterInput {
  readonly sessionId: string;
  readonly kind: PendingKind;
  readonly fingerprint: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** The hook's own timeout `T` in milliseconds. */
  readonly hookTimeoutMs: number;
  /** The agent whose hook is held; absent means `claude-code`. */
  readonly agent?: AgentAdapterId;
}

export interface Registration {
  readonly request: PendingRequest;
  /** Settles exactly once with the outcome for this registration. */
  readonly settled: Promise<PendingOutcome>;
  /** True when this registration reused the id of a duplicate within 2 s. */
  readonly duplicate: boolean;
  /**
   * Ends this registration with a handoff (for example the hook disconnected). A no-op
   * once it has settled, so it can never affect a request that replaced it.
   */
  cancel(reason: HandoffReason): void;
}

export type ResolveResult = 'resolved' | 'released' | 'unknown';

export type PendingEvent =
  | { readonly type: 'added'; readonly request: PendingRequest; readonly duplicate: boolean }
  | {
      readonly type: 'removed';
      readonly request: PendingRequest;
      readonly outcome: PendingOutcome;
    };

export interface PendingStore {
  register(input: RegisterInput): Registration;
  /**
   * Settles the request with a hook response. `released` when the request already
   * ended (decided, deadline, replacement, release): late and second decisions are
   * rejected (04 risk 8, D25).
   */
  resolve(id: string, response: Readonly<Record<string, unknown>>): ResolveResult;
  /** Hands the request back to the terminal early ("Reply in terminal"). */
  release(id: string, reason?: HandoffReason): ResolveResult;
  /** Hands every pending request back (agent shutdown). */
  releaseAll(reason: HandoffReason): void;
  list(): readonly PendingRequest[];
  get(id: string): PendingRequest | undefined;
  /** True when the id is remembered as ended (decided, deadline, replaced, released). */
  ended(id: string): boolean;
}

export interface PendingStoreOptions {
  readonly clock: Clock;
  readonly timer: Timer;
  readonly random: Random;
  readonly onEvent?: (event: PendingEvent) => void;
}

interface Entry {
  readonly request: PendingRequest;
  readonly key: string;
  readonly timer: TimerHandle;
  readonly settle: (outcome: PendingOutcome) => void;
}

function slotKey(sessionId: string, kind: PendingKind): string {
  return `${kind}\0${sessionId}`;
}

/**
 * In-flight hook requests (D10, 04 §5.2). At most one per `session_id + kind`: a new
 * request for the same slot replaces the old one (which hands off); a repeat with the
 * same fingerprint within 2 s keeps the old id. At `T − 10 s` a request hands off and its
 * id is remembered as `released`, so a decision that arrives later is rejected.
 */
export function createPendingStore(options: PendingStoreOptions): PendingStore {
  const { clock, timer, random } = options;
  const bySlot = new Map<string, Entry>();
  const byId = new Map<string, Entry>();
  const released = new Set<string>();

  function remember(id: string): void {
    released.add(id);
    if (released.size > RELEASED_MEMORY) {
      const oldest = released.values().next().value as string;
      released.delete(oldest);
    }
  }

  function finish(entry: Entry, outcome: PendingOutcome): void {
    entry.timer.cancel();
    if (bySlot.get(entry.key) === entry) bySlot.delete(entry.key);
    if (byId.get(entry.request.id) === entry) {
      byId.delete(entry.request.id);
      // A replaced duplicate keeps its id alive in the new entry; only a real end counts,
      // so a second decision for a decided request is refused too (decide-once, D25).
      remember(entry.request.id);
    }
    entry.settle(outcome);
    options.onEvent?.({ type: 'removed', request: entry.request, outcome });
  }

  /** A UUID: the id travels to the phone as `ApprovalRequest.id` (D7). */
  function newId(): string {
    return uuidV4(random);
  }

  return {
    register(input) {
      const now = clock.now();
      const key = slotKey(input.sessionId, input.kind);
      const previous = bySlot.get(key);
      const duplicate =
        previous !== undefined &&
        previous.request.fingerprint === input.fingerprint &&
        now - previous.request.createdAt <= DUPLICATE_WINDOW_MS;
      const id = duplicate ? previous.request.id : newId();
      const holdMs = Math.max(0, input.hookTimeoutMs - DEADLINE_MARGIN_MS);
      const request: PendingRequest = {
        id,
        sessionId: input.sessionId,
        kind: input.kind,
        fingerprint: input.fingerprint,
        payload: input.payload,
        createdAt: now,
        deadline: now + holdMs,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
      };
      let settle!: (outcome: PendingOutcome) => void;
      let done = false;
      const settled = new Promise<PendingOutcome>((resolve) => {
        settle = (outcome) => {
          done = true;
          resolve(outcome);
        };
      });
      const entry: Entry = {
        request,
        key,
        settle,
        timer: timer.after(holdMs, () => {
          if (!done) finish(entry, { type: 'handoff', reason: 'deadline' });
        }),
      };
      if (previous !== undefined) {
        // The old entry hands off; with a duplicate the id lives on in the new entry.
        if (duplicate) byId.delete(id);
        finish(previous, { type: 'handoff', reason: 'replaced' });
      }
      bySlot.set(key, entry);
      byId.set(id, entry);
      released.delete(id);
      options.onEvent?.({ type: 'added', request, duplicate });
      return {
        request,
        settled,
        duplicate,
        cancel(reason) {
          if (!done) finish(entry, { type: 'handoff', reason });
        },
      };
    },
    resolve(id, response) {
      const entry = byId.get(id);
      if (entry === undefined) return released.has(id) ? 'released' : 'unknown';
      finish(entry, { type: 'decided', response });
      return 'resolved';
    },
    release(id, reason = 'released') {
      const entry = byId.get(id);
      if (entry === undefined) return released.has(id) ? 'released' : 'unknown';
      finish(entry, { type: 'handoff', reason });
      return 'resolved';
    },
    releaseAll(reason) {
      for (const entry of [...byId.values()]) finish(entry, { type: 'handoff', reason });
    },
    list() {
      return [...byId.values()].map((entry) => entry.request);
    },
    get(id) {
      return byId.get(id)?.request;
    },
    ended(id) {
      return released.has(id);
    },
  };
}
