import type { Clock } from '@remote-control/protocol';

import {
  EXIT2_BLOCKS,
  type HookEventName,
  MATCHER_FIELD,
  SESSION_END_MAX_SECONDS,
  defaultTimeoutSeconds,
} from './events.js';
import { matcherMatches } from './matcher.js';
import type { Env } from './paths.js';
import type { CommandHook, HookSettings } from './settings.js';
import { spawnHook } from './spawn-hook.js';

export type HookInput = Readonly<Record<string, unknown>> & { readonly hook_event_name: string };

/** How one hook ended, after the exit-code map of 04 §2.1. */
export type HookStatus =
  /** Exit 0 (with or without JSON on stdout). */
  | 'ok'
  /** Exit 2 on an event that honours it; stderr is the reason. */
  | 'blocked'
  /** Non-blocking error: other exit code, exit 2 where not honoured, invalid JSON, spawn failure. */
  | 'error'
  /** Killed at its timeout; a non-blocking error. */
  | 'timeout'
  /** `async: true`: started in the background, its result never decides anything. */
  | 'async';

export interface HookOutcome {
  readonly command: string;
  readonly status: HookStatus;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Parsed stdout JSON (exit 0 only). */
  readonly output?: Readonly<Record<string, unknown>>;
  readonly error?: string;
  readonly durationMs: number;
  /** True when `onFailure: "block"` turned this error or timeout into a block. */
  readonly failedClosed: boolean;
}

export type EventDecision = 'allow' | 'deny' | 'ask' | 'defer' | 'block' | 'none';

export interface FireResult {
  readonly event: HookEventName;
  readonly outcomes: readonly HookOutcome[];
  /**
   * The effective decision. `PreToolUse`: allow/deny/ask/defer; `PermissionRequest`:
   * allow/deny; blocking events: block; `none` = no hook decided.
   */
  readonly decision: EventDecision;
  readonly reason?: string;
  readonly updatedInput?: Readonly<Record<string, unknown>>;
  readonly updatedPermissions?: readonly unknown[];
  readonly interrupt: boolean;
  /** False when any hook returned `continue: false`. */
  readonly continue: boolean;
  readonly stopReason?: string;
  readonly additionalContext: readonly string[];
  readonly systemMessages: readonly string[];
  readonly errors: readonly string[];
}

export interface HookRunnerOptions {
  readonly settings: HookSettings;
  readonly cwd: string;
  readonly env: Env;
  readonly clock: Clock;
}

interface Candidate {
  readonly decision: Exclude<EventDecision, 'none'>;
  readonly reason?: string;
  readonly updatedInput?: Readonly<Record<string, unknown>>;
  readonly updatedPermissions?: readonly unknown[];
  readonly interrupt?: boolean;
}

/** 04 §2.3: `deny > defer > ask > allow`; 04 §2.5: the most restrictive decision wins. */
const PRECEDENCE: Record<Exclude<EventDecision, 'none'>, number> = {
  block: 5,
  deny: 4,
  defer: 3,
  ask: 2,
  allow: 1,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function hookTimeoutMs(event: HookEventName, hook: CommandHook): number {
  const seconds = hook.timeout ?? defaultTimeoutSeconds(event);
  const capped = event === 'SessionEnd' ? Math.min(seconds, SESSION_END_MAX_SECONDS) : seconds;
  return Math.round(capped * 1000);
}

/** Reads a decision out of one hook's JSON output, per event (04 §2.2–2.4). */
function candidateFromOutput(
  event: HookEventName,
  output: Readonly<Record<string, unknown>>,
): Candidate | undefined {
  const specific = isRecord(output.hookSpecificOutput) ? output.hookSpecificOutput : undefined;
  if (event === 'PermissionRequest') {
    const decision = specific !== undefined && isRecord(specific.decision) ? specific.decision : {};
    if (decision.behavior !== 'allow' && decision.behavior !== 'deny') return undefined;
    const message = optionalString(decision.message);
    return {
      decision: decision.behavior,
      ...(message !== undefined ? { reason: message } : {}),
      ...(isRecord(decision.updatedInput) ? { updatedInput: decision.updatedInput } : {}),
      ...(Array.isArray(decision.updatedPermissions)
        ? { updatedPermissions: decision.updatedPermissions }
        : {}),
      interrupt: decision.interrupt === true,
    };
  }
  if (event === 'PreToolUse') {
    const permission = specific?.permissionDecision;
    if (
      permission === 'allow' ||
      permission === 'deny' ||
      permission === 'ask' ||
      permission === 'defer'
    ) {
      const reason = optionalString(specific?.permissionDecisionReason);
      return {
        decision: permission,
        ...(reason !== undefined ? { reason } : {}),
        ...(isRecord(specific?.updatedInput) ? { updatedInput: specific.updatedInput } : {}),
      };
    }
  }
  // Legacy top-level `decision: "block"` (04 §2.1 "decision/reason (legacy)"), honoured on
  // events that can block. Assumption: on PreToolUse it means deny.
  if (output.decision === 'block' && EXIT2_BLOCKS[event]) {
    const reason = optionalString(output.reason);
    return {
      decision: event === 'PreToolUse' ? 'deny' : 'block',
      ...(reason !== undefined ? { reason } : {}),
    };
  }
  return undefined;
}

/** What a failure with `onFailure: "block"` means per event (D10: a deny for PermissionRequest). */
function failClosedCandidate(event: HookEventName, reason: string): Candidate | undefined {
  if (event === 'PermissionRequest' || event === 'PreToolUse') return { decision: 'deny', reason };
  // Assumption: on events that cannot block, `onFailure` has nothing to turn into a block.
  return EXIT2_BLOCKS[event] ? { decision: 'block', reason } : undefined;
}

/**
 * Fires hook events the way Claude Code does (04 §2.1, 07 §5.3): selects matcher groups,
 * runs every matching `command` hook in parallel with the event JSON on stdin, applies
 * per-hook timeouts, maps exit codes, honours `async` and `onFailure`, and folds the
 * results into one decision.
 */
export class HookRunner {
  readonly #options: HookRunnerOptions;
  readonly #background = new Set<Promise<unknown>>();

  constructor(options: HookRunnerOptions) {
    this.#options = options;
  }

  /** Hooks that would run for this input, in settings order. */
  matchingHooks(event: HookEventName, input: HookInput): CommandHook[] {
    const { settings } = this.#options;
    if (settings.disableAllHooks) return [];
    const field = MATCHER_FIELD[event];
    const value = field === null ? undefined : optionalString(input[field]);
    return (settings.groups[event] ?? [])
      .filter((group) => field === null || matcherMatches(group.matcher, value))
      .flatMap((group) => group.hooks);
  }

  /** Waits for every `async` hook started so far (used before a session exits). */
  async drain(): Promise<void> {
    await Promise.all([...this.#background]);
  }

  async fire(event: HookEventName, input: HookInput): Promise<FireResult> {
    const hooks = this.matchingHooks(event, input);
    const outcomes = await Promise.all(hooks.map((hook) => this.#runOne(event, hook, input)));
    return this.#fold(event, hooks, outcomes);
  }

  async #runOne(event: HookEventName, hook: CommandHook, input: HookInput): Promise<HookOutcome> {
    const { clock, cwd, env } = this.#options;
    const started = clock.now();
    const run = spawnHook({
      command: hook.command,
      stdin: JSON.stringify(input),
      cwd,
      // 07 §2.1: `CLAUDE_PROJECT_DIR` is set in the hook's environment.
      env: { ...env, CLAUDE_PROJECT_DIR: cwd },
      timeoutMs: hookTimeoutMs(event, hook),
    });
    if (hook.async === true) {
      // 04 §2.1: async hooks cannot block or decide; their output arrives on a later turn.
      const tracked = run.finally(() => this.#background.delete(tracked));
      this.#background.add(tracked);
      return {
        command: hook.command,
        status: 'async',
        exitCode: null,
        stdout: '',
        stderr: '',
        durationMs: 0,
        failedClosed: false,
      };
    }
    const result = await run;
    const base = {
      command: hook.command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: clock.now() - started,
    };
    const failure = (status: 'error' | 'timeout', error: string): HookOutcome => ({
      ...base,
      status,
      error,
      failedClosed: hook.onFailure === 'block',
    });
    if (result.timedOut)
      return failure('timeout', `timed out after ${hookTimeoutMs(event, hook)} ms`);
    if (result.spawnError !== undefined)
      return failure('error', `spawn failed: ${result.spawnError}`);
    if (result.exitCode === 2) {
      if (EXIT2_BLOCKS[event]) return { ...base, status: 'blocked', failedClosed: false };
      return failure('error', `exit 2 is not honoured for ${event}`);
    }
    if (result.exitCode !== 0) return failure('error', `exit code ${String(result.exitCode)}`);
    const trimmed = result.stdout.trim();
    // Assumption: plain-text stdout on exit 0 is not an error (it is context or transcript
    // output); only stdout that starts like JSON and fails to parse is invalid output.
    if (!trimmed.startsWith('{')) return { ...base, status: 'ok', failedClosed: false };
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!isRecord(parsed)) return failure('error', 'stdout JSON is not an object');
      const specific = parsed.hookSpecificOutput;
      if (
        isRecord(specific) &&
        specific.hookEventName !== undefined &&
        specific.hookEventName !== event
      ) {
        return failure('error', `hookSpecificOutput.hookEventName is not ${event}`);
      }
      return { ...base, status: 'ok', output: parsed, failedClosed: false };
    } catch {
      return failure('error', 'invalid JSON on stdout');
    }
  }

  #fold(event: HookEventName, hooks: CommandHook[], outcomes: HookOutcome[]): FireResult {
    const candidates: Candidate[] = [];
    const errors: string[] = [];
    const additionalContext: string[] = [];
    const systemMessages: string[] = [];
    let keepGoing = true;
    let stopReason: string | undefined;
    outcomes.forEach((outcome, index) => {
      const hook = hooks[index] as CommandHook;
      if (outcome.status === 'error' || outcome.status === 'timeout') {
        errors.push(`${hook.command}: ${outcome.error ?? outcome.status}`);
        if (outcome.failedClosed) {
          const candidate = failClosedCandidate(event, `Hook failed: ${outcome.error ?? ''}`);
          if (candidate !== undefined) candidates.push(candidate);
        }
        return;
      }
      if (outcome.status === 'blocked') {
        const reason = outcome.stderr.trim();
        candidates.push({ decision: event === 'PreToolUse' ? 'deny' : 'block', reason });
        return;
      }
      const output = outcome.output;
      if (output === undefined) return;
      const candidate = candidateFromOutput(event, output);
      if (candidate !== undefined) candidates.push(candidate);
      if (output.continue === false) {
        keepGoing = false;
        stopReason ??= optionalString(output.stopReason);
      }
      const message = optionalString(output.systemMessage);
      if (message !== undefined) systemMessages.push(message);
      const specific = isRecord(output.hookSpecificOutput) ? output.hookSpecificOutput : {};
      const context = optionalString(specific.additionalContext);
      if (context !== undefined) additionalContext.push(context);
    });
    const winner = candidates.reduce<Candidate | undefined>(
      (best, next) =>
        best === undefined || PRECEDENCE[next.decision] > PRECEDENCE[best.decision] ? next : best,
      undefined,
    );
    return {
      event,
      outcomes,
      decision: winner?.decision ?? 'none',
      ...(winner?.reason !== undefined ? { reason: winner.reason } : {}),
      ...(winner?.updatedInput !== undefined ? { updatedInput: winner.updatedInput } : {}),
      ...(winner?.updatedPermissions !== undefined
        ? { updatedPermissions: winner.updatedPermissions }
        : {}),
      interrupt: winner?.interrupt === true,
      continue: keepGoing,
      ...(stopReason !== undefined ? { stopReason } : {}),
      additionalContext,
      systemMessages,
      errors,
    };
  }
}
