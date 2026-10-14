import type { AgentAdapterId } from '../ports/agent-adapter.js';
import type { PendingKind, PendingRequest, PendingStore } from './pending-store.js';

/** A hook event as posted by `hook.js`: the Claude Code stdin JSON, unchanged. */
export type HookInput = Readonly<Record<string, unknown>> & {
  readonly hook_event_name: string;
  readonly session_id: string;
};

/**
 * The receiver's answer to `hook.js`. 200 with a body: `hook.js` prints the body
 * verbatim. 204: `hook.js` prints nothing. Both end with exit 0.
 */
export type HookReply =
  | { readonly status: 200; readonly body: Readonly<Record<string, unknown>> }
  | { readonly status: 204 };

export interface HookContext {
  /** The hook's own timeout `T` (from `hook.js`), in milliseconds. */
  readonly hookTimeoutMs: number;
  /** Aborted when the hook process disconnects. */
  readonly signal: AbortSignal;
  /** The agent that ran the hook (`hook.js --adapter`); absent means `claude-code`. */
  readonly agent?: AgentAdapterId;
}

export type HookHandler = (input: HookInput, context: HookContext) => Promise<HookReply>;

/** The question tool whose answer goes through `PreToolUse` (D11). */
export const ASK_USER_QUESTION = 'AskUserQuestion';

/**
 * The blocking kind of a hook event, or `undefined` for a feed-only event (D11). Codex has
 * no question tool, so only its `PermissionRequest` blocks (04 §2.11); Gemini has no
 * approval hook, so its `BeforeTool` gate blocks (04 §5.9).
 */
export function blockingKind(
  input: HookInput,
  agent: AgentAdapterId = 'claude-code',
): PendingKind | undefined {
  if (agent === 'gemini') return input.hook_event_name === 'BeforeTool' ? 'permission' : undefined;
  if (input.hook_event_name === 'PermissionRequest') return 'permission';
  if (agent !== 'claude-code') return undefined;
  if (input.hook_event_name === 'PreToolUse' && input['tool_name'] === ASK_USER_QUESTION) {
    return 'question';
  }
  return undefined;
}

/** Identity of a blocking request: tool name and input (a retry has both unchanged). */
export function fingerprint(input: HookInput): string {
  const toolName = typeof input['tool_name'] === 'string' ? input['tool_name'] : '';
  return `${toolName}\0${JSON.stringify(input['tool_input'] ?? null)}`;
}

/** No decision: Claude Code continues as if the hook were absent (D10 handoff). */
const HANDOFF: HookReply = { status: 200, body: {} };

export interface HookDispatcherOptions {
  readonly store: PendingStore;
  /** Every event that reached the agent, blocking or not (registry, logs). */
  readonly onEvent?: (input: HookInput, agent: AgentAdapterId) => void;
  /**
   * The hook output when a request reaches its deadline (`agent.onExpire: "deny"`, D10);
   * absent = handoff. Every other handoff (replaced, released, disconnected, shutdown)
   * still returns no decision.
   */
  readonly onDeadline?: (request: PendingRequest) => Readonly<Record<string, unknown>>;
  /**
   * `remotectl pause` (M1-03), asked per blocking hook so a running agent follows
   * `pause`/`resume` without a restart. While it is `true` a blocking hook is handed back
   * at once and never registered, so no phone sees it and no push goes out. A check that
   * throws counts as not paused.
   */
  readonly paused?: () => Promise<boolean>;
}

async function isPaused(check: () => Promise<boolean>): Promise<boolean> {
  try {
    return (await check()) === true;
  } catch {
    return false;
  }
}

/**
 * Routes hook events: blocking ones (`PermissionRequest`, `PreToolUse` for
 * `AskUserQuestion`) wait in the pending store for a decision or a handoff; every other
 * event is a feed event and is answered at once with no output.
 */
export function createHookDispatcher(options: HookDispatcherOptions): HookHandler {
  const { store } = options;
  return async (input, context) => {
    const agent = context.agent ?? 'claude-code';
    options.onEvent?.(input, agent);
    const kind = blockingKind(input, agent);
    if (kind === undefined) return { status: 204 };
    // Awaited only when a pause check is wired: without one a hook registers synchronously.
    if (options.paused !== undefined && (await isPaused(options.paused))) return HANDOFF;
    const registration = store.register({
      sessionId: input.session_id,
      kind,
      fingerprint: fingerprint(input),
      payload: input,
      hookTimeoutMs: context.hookTimeoutMs,
      ...(agent === 'claude-code' ? {} : { agent }),
    });
    const onAbort = (): void => registration.cancel('disconnected');
    if (context.signal.aborted) onAbort();
    else context.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const outcome = await registration.settled;
      if (outcome.type === 'decided') return { status: 200, body: outcome.response };
      if (outcome.reason === 'deadline' && options.onDeadline !== undefined) {
        return { status: 200, body: options.onDeadline(registration.request) };
      }
      return HANDOFF;
    } finally {
      context.signal.removeEventListener('abort', onAbort);
    }
  };
}
