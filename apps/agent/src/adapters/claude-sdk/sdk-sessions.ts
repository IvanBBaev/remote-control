import type { PermissionMode } from '@remote-control/protocol';

import {
  ASK_USER_QUESTION,
  type HookContext,
  type HookHandler,
  type HookInput,
  type HookReply,
} from '../../core/hook-dispatcher.js';
import { FEED_EVENTS, FEED_TIMEOUT_SECONDS } from '../../core/hooks-installer.js';
import type {
  AgentSdk,
  SdkCanUseTool,
  SdkHookCallback,
  SdkHookMatcher,
  SdkMessage,
  SdkPermissionResult,
  SdkQuery,
  SdkUserMessage,
} from '../../ports/agent-sdk.js';
import type { AllowedRepository, ClaudeCli, RosterEntry } from '../../ports/claude-cli.js';
import type { Timer } from '../../ports/timer.js';
import { DEFAULT_DENY_MESSAGE, NO_DECISION_MESSAGE } from '../claude-code/decide.js';

/** The one credential source an SDK session may run on (SDK-O, ADR 0015). */
export const API_KEY_SOURCE = 'ANTHROPIC_API_KEY';
/** How long `start` waits for the session's `init` message. */
export const SDK_START_TIMEOUT_MS = 60_000;

const FEED_MS = FEED_TIMEOUT_SECONDS * 1000;

export interface SdkSessionsOptions {
  /** Loads the SDK on first use; `undefined` when it is not installed. */
  readonly sdk: () => Promise<AgentSdk | undefined>;
  /** The CLI: its roster is merged with the SDK sessions, and `version` comes from it. */
  readonly cli: ClaudeCli;
  /** The hook dispatcher: SDK permissions, questions and feed events go through it. */
  readonly dispatch: HookHandler;
  /** `hooks.holdSeconds`: a blocking request's hold, as for a settings-file hook. */
  readonly holdSeconds: number;
  /** Whether `ANTHROPIC_API_KEY` is set; its value never reaches this module. */
  readonly apiKeySet: boolean;
  readonly timer: Timer;
  readonly startTimeoutMs?: number;
  /** Event names, ids and codes only (I3). */
  readonly log?: (event: string, fields: Readonly<Record<string, unknown>>) => void;
}

/** The `ClaudeCli` port with sessions started and continued through the SDK (04 W15). */
export interface SdkClaudeCli extends ClaudeCli {
  /** Closes every live query (agent shutdown). */
  close(): void;
}

/** A streaming prompt: user turns pushed while the query runs. */
interface InputQueue extends AsyncIterable<SdkUserMessage> {
  push(message: SdkUserMessage): void;
  end(): void;
}

function createInputQueue(): InputQueue {
  const queued: SdkUserMessage[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  return {
    push(message) {
      if (ended) return;
      queued.push(message);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = queued.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
      }
    },
  };
}

function userMessage(text: string, sessionId: string): SdkUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
}

interface SdkSession {
  id: string | undefined;
  readonly name: string | undefined;
  readonly cwd: string;
  /** The mode it started in; a follow-up after the live query ended keeps it. */
  readonly permissionMode: PermissionMode | undefined;
  readonly input: InputQueue;
  query: SdkQuery | undefined;
  state: RosterEntry['state'];
  status: 'busy' | 'idle';
}

function rosterRow(session: SdkSession & { id: string }): RosterEntry {
  return {
    sessionId: session.id,
    cwd: session.cwd,
    kind: 'background',
    state: session.state,
    status: session.state === 'working' ? session.status : undefined,
    name: session.name,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

/**
 * The SDK answer for a `PermissionRequest` dispatch: the Claude Code hook output read back.
 * An allow keeps the tool input; no decision (a handoff, a pause) is a deny, since an SDK
 * session has no terminal to hand off to (ADR 0015).
 */
export function permissionResult(reply: HookReply): SdkPermissionResult {
  const output = reply.status === 200 ? reply.body['hookSpecificOutput'] : undefined;
  const decision = isRecord(output) ? output['decision'] : undefined;
  if (isRecord(decision) && decision['behavior'] === 'allow') {
    const rules = decision['updatedPermissions'];
    return Array.isArray(rules)
      ? { behavior: 'allow', updatedPermissions: rules }
      : { behavior: 'allow' };
  }
  if (isRecord(decision) && decision['behavior'] === 'deny') {
    const message = decision['message'];
    return {
      behavior: 'deny',
      message: typeof message === 'string' ? message : DEFAULT_DENY_MESSAGE,
    };
  }
  return { behavior: 'deny', message: NO_DECISION_MESSAGE };
}

/**
 * Claude Code sessions run through the Agent SDK for API-key users (04 W15, ADR 0015).
 * Approvals reach the phone through the same dispatcher and pending store as the CLI's
 * hooks: `canUseTool` dispatches a `PermissionRequest`, an `AskUserQuestion` call is held by
 * a `PreToolUse` hook callback, and the feed hooks are callbacks too. The SDK reads the
 * project and local settings only, so a user-level `remotectl` hook never doubles them.
 */
export function createSdkClaudeCli(options: SdkSessionsOptions): SdkClaudeCli {
  const log = options.log ?? (() => {});
  const startTimeoutMs = options.startTimeoutMs ?? SDK_START_TIMEOUT_MS;
  const sessions = new Map<string, SdkSession>();
  const starting = new Set<SdkSession>();
  /** Resumes still waiting for `init`, by session id: a second one waits its turn. */
  const resuming = new Map<string, Promise<number>>();

  function context(signal: AbortSignal, hookTimeoutMs: number): HookContext {
    return { hookTimeoutMs, signal, agent: 'claude-code', origin: 'sdk' };
  }

  const feedHook: SdkHookCallback = async (input, _toolUseId, { signal }) => {
    await options.dispatch(input as HookInput, context(signal, FEED_MS));
    return {};
  };

  /** `AskUserQuestion` (D11): the dispatcher's `PreToolUse` output goes back unchanged. */
  const questionHook: SdkHookCallback = async (input, _toolUseId, { signal }) => {
    const reply = await options.dispatch(
      input as HookInput,
      context(signal, options.holdSeconds * 1000),
    );
    return reply.status === 200 ? reply.body : {};
  };

  const hooks: Readonly<Record<string, readonly SdkHookMatcher[]>> = {
    PreToolUse: [
      { matcher: `^${ASK_USER_QUESTION}$`, hooks: [questionHook], timeout: options.holdSeconds },
    ],
    ...Object.fromEntries(
      FEED_EVENTS.map((event) => [event, [{ hooks: [feedHook], timeout: FEED_TIMEOUT_SECONDS }]]),
    ),
  };

  function canUseTool(session: SdkSession): SdkCanUseTool {
    return async (toolName, input, { signal, suggestions, suppressAlwaysAllowRule }) => {
      // A question the phone did not answer: there is no terminal to ask it in.
      if (toolName === ASK_USER_QUESTION || session.id === undefined) {
        return { behavior: 'deny', message: NO_DECISION_MESSAGE };
      }
      const request: HookInput = {
        hook_event_name: 'PermissionRequest',
        session_id: session.id,
        cwd: session.cwd,
        tool_name: toolName,
        tool_input: input,
        // "Always" is offered only when the SDK allows a persistent rule (D24).
        ...(suggestions !== undefined && suppressAlwaysAllowRule !== true
          ? { permission_suggestions: suggestions }
          : {}),
      };
      return permissionResult(
        await options.dispatch(request, context(signal, options.holdSeconds * 1000)),
      );
    };
  }

  /** Reads the query to its end; `ready` settles on the first `init` or at the end. */
  async function consume(
    session: SdkSession,
    query: SdkQuery,
    ready: (ok: boolean) => void,
  ): Promise<void> {
    try {
      for await (const message of query) {
        if (message.type === 'system' && message.subtype === 'init') {
          if (!initAccepted(session, message)) {
            ready(false);
            break;
          }
          ready(true);
        } else if (message.type === 'result') {
          session.status = 'idle';
        }
      }
      if (session.state === 'working') session.state = 'done';
    } catch {
      session.state = 'failed';
      log('sdk_session_failed', { session_id: session.id ?? null });
    } finally {
      session.input.end();
      session.query?.close();
      session.query = undefined;
      ready(false);
    }
  }

  function initAccepted(session: SdkSession, message: SdkMessage): boolean {
    // SDK-O: an API key from the environment only, never a claude.ai login.
    if (message.apiKeySource !== API_KEY_SOURCE) {
      session.state = 'stopped';
      log('sdk_auth_refused', {
        api_key_source: typeof message.apiKeySource === 'string' ? message.apiKeySource : null,
      });
      return false;
    }
    // A resumed session takes over its id; a query still live under it (asked from
    // another repository) ends, so one process at a time writes its transcript.
    if (typeof message.session_id === 'string') {
      const previous = sessions.get(message.session_id);
      if (previous !== undefined && previous !== session) {
        previous.input.end();
        previous.query?.close();
      }
      session.id = message.session_id;
      sessions.set(session.id, session);
    }
    session.status = 'busy';
    return true;
  }

  async function run(
    repository: AllowedRepository,
    name: string | undefined,
    prompt: string,
    permissionMode: PermissionMode | undefined,
    resume: string | undefined,
  ): Promise<number> {
    if (!options.apiKeySet) {
      log('sdk_no_api_key', {});
      return 1;
    }
    const sdk = await options.sdk();
    if (sdk === undefined) {
      log('sdk_unavailable', {});
      return 1;
    }
    const session: SdkSession = {
      id: resume,
      name,
      cwd: repository.realPath,
      permissionMode,
      input: createInputQueue(),
      query: undefined,
      state: 'working',
      status: 'busy',
    };
    session.input.push(userMessage(prompt, resume ?? ''));
    const query = sdk.query({
      prompt: session.input,
      options: {
        cwd: repository.realPath,
        ...(permissionMode === undefined ? {} : { permissionMode }),
        canUseTool: canUseTool(session),
        hooks,
        settingSources: ['project', 'local'],
        ...(resume === undefined ? {} : { resume }),
      },
    });
    session.query = query;
    starting.add(session);
    const ok = await new Promise<boolean>((resolve) => {
      let settled = false;
      const timeout = options.timer.after(startTimeoutMs, () => {
        log('sdk_start_timeout', {});
        session.state = 'failed';
        session.query?.close();
        finish(false);
      });
      function finish(value: boolean): void {
        if (settled) return;
        settled = true;
        timeout.cancel();
        resolve(value);
      }
      void consume(session, query, finish);
    });
    starting.delete(session);
    return ok ? 0 : 1;
  }

  return {
    version: () => options.cli.version(),
    async agents() {
      const roster = await options.cli.agents();
      const own = [...sessions.values()].flatMap((session) =>
        session.id === undefined ? [] : [rosterRow({ ...session, id: session.id })],
      );
      // Ours last: a row the CLI also lists takes the SDK's state.
      if (roster === undefined) return own.length === 0 ? undefined : own;
      return [...roster, ...own];
    },
    start: (repository, name, prompt, permissionMode) =>
      run(repository, name, prompt, permissionMode, undefined),
    async resume(repository, sessionId, prompt) {
      // A follow-up sent while the session is being resumed goes into that query.
      for (let pending = resuming.get(sessionId); pending !== undefined;) {
        await pending.catch(() => 1);
        pending = resuming.get(sessionId);
      }
      const known = sessions.get(sessionId);
      if (known?.query !== undefined && known.cwd === repository.realPath) {
        known.input.push(userMessage(prompt, sessionId));
        known.status = 'busy';
        return 0;
      }
      const resumed = run(repository, known?.name, prompt, known?.permissionMode, sessionId);
      resuming.set(sessionId, resumed);
      try {
        return await resumed;
      } finally {
        if (resuming.get(sessionId) === resumed) resuming.delete(sessionId);
      }
    },
    close() {
      for (const session of [...sessions.values(), ...starting]) {
        session.input.end();
        session.query?.close();
      }
    },
  };
}
