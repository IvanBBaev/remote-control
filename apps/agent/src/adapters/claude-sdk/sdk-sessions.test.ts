import { describe, expect, it, vi } from 'vitest';

import type { HookContext, HookHandler, HookInput, HookReply } from '../../core/hook-dispatcher.js';
import { FEED_EVENTS } from '../../core/hooks-installer.js';
import type {
  AgentSdk,
  SdkMessage,
  SdkPermissionOptions,
  SdkQueryOptions,
} from '../../ports/agent-sdk.js';
import type { AllowedRepository, ClaudeCli, RosterEntry } from '../../ports/claude-cli.js';
import { manualTime, waitFor } from '../../testing/manual-time.js';
import { DEFAULT_DENY_MESSAGE, NO_DECISION_MESSAGE } from '../claude-code/decide.js';
import {
  createSdkClaudeCli,
  permissionResult,
  SDK_START_TIMEOUT_MS,
  type SdkSessionsOptions,
} from './sdk-sessions.js';

const REPO: AllowedRepository = { allowed: true, root: '/work/app', realPath: '/work/app' };
const OTHER: AllowedRepository = { allowed: true, root: '/work/lib', realPath: '/work/lib' };

interface QueryCall {
  readonly options: SdkQueryOptions;
  readonly prompts: string[];
  closed: boolean;
  /** Ends the message stream, as the SDK does when the session exits. */
  end(): void;
}

/** Polls `predicate` across event-loop turns, for state the query loop settles later. */
async function eventually(predicate: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('eventually: condition not met');
}

/**
 * An SDK whose query answers `init` on the first user turn and a `result` on each turn,
 * until the input ends or the query is closed. `init` overrides the init message.
 */
function fakeSdk(init: Partial<SdkMessage> | (() => never) = {}): {
  sdk: AgentSdk;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  let next = 0;
  const sdk: AgentSdk = {
    query({ prompt, options }) {
      let stop: () => void = () => {};
      const stopped = new Promise<IteratorResult<never>>(
        (resolve) => (stop = () => resolve({ done: true, value: undefined as never })),
      );
      const call: QueryCall = { options, prompts: [], closed: false, end: () => stop() };
      calls.push(call);
      const sessionId = options.resume ?? `sdk-${++next}`;
      return {
        close() {
          call.closed = true;
          stop();
        },
        async *[Symbol.asyncIterator]() {
          const input = prompt[Symbol.asyncIterator]();
          for (let turn = 0; ; turn++) {
            const message = await Promise.race([input.next(), stopped]);
            if (message.done === true) return;
            call.prompts.push(message.value.message.content);
            if (turn === 0) {
              if (typeof init === 'function') init();
              yield {
                type: 'system',
                subtype: 'init',
                apiKeySource: 'ANTHROPIC_API_KEY',
                session_id: sessionId,
                ...init,
              };
            }
            yield { type: 'result', subtype: 'success', session_id: sessionId };
          }
        },
      };
    },
  };
  return { sdk, calls };
}

function fakeCli(roster: readonly RosterEntry[] | undefined): ClaudeCli {
  return {
    version: () => Promise.resolve('2.1.200'),
    agents: () => Promise.resolve(roster),
    start: vi.fn(() => Promise.resolve(0)),
    resume: vi.fn(() => Promise.resolve(0)),
  };
}

function setup(overrides: Partial<SdkSessionsOptions> = {}, sdk = fakeSdk()) {
  const time = manualTime();
  const dispatched: { input: HookInput; context: HookContext }[] = [];
  let reply: HookReply = { status: 204 };
  const dispatch: HookHandler = (input, context) => {
    dispatched.push({ input, context });
    return Promise.resolve(reply);
  };
  const log = vi.fn();
  const cli = createSdkClaudeCli({
    sdk: () => Promise.resolve(sdk.sdk),
    cli: fakeCli([]),
    dispatch,
    holdSeconds: 300,
    apiKeySet: true,
    timer: time.timer,
    log,
    ...overrides,
  });
  return {
    cli,
    calls: sdk.calls,
    dispatched,
    log,
    time,
    reply: (next: HookReply) => (reply = next),
  };
}

const PERMISSION: SdkPermissionOptions = { signal: new AbortController().signal };

describe('permissionResult', () => {
  const output = (decision: Record<string, unknown>): HookReply => ({
    status: 200,
    body: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } },
  });

  it('maps an allow to an allow that keeps the tool input', () => {
    expect(permissionResult(output({ behavior: 'allow', interrupt: false }))).toEqual({
      behavior: 'allow',
    });
  });

  it('passes an "always" rule on', () => {
    const rules = [{ type: 'addRules', rules: [{ toolName: 'Bash' }], destination: 'session' }];
    expect(permissionResult(output({ behavior: 'allow', updatedPermissions: rules }))).toEqual({
      behavior: 'allow',
      updatedPermissions: rules,
    });
  });

  it('maps a deny with its message, or the default one', () => {
    expect(permissionResult(output({ behavior: 'deny', message: 'Not now' }))).toEqual({
      behavior: 'deny',
      message: 'Not now',
    });
    expect(permissionResult(output({ behavior: 'deny' }))).toEqual({
      behavior: 'deny',
      message: DEFAULT_DENY_MESSAGE,
    });
  });

  it('denies when there is no decision (handoff, pause, 204)', () => {
    const none = { behavior: 'deny', message: NO_DECISION_MESSAGE };
    expect(permissionResult({ status: 200, body: {} })).toEqual(none);
    expect(permissionResult({ status: 204 })).toEqual(none);
    expect(permissionResult(output({ behavior: 'ask' }))).toEqual(none);
  });
});

describe('createSdkClaudeCli', () => {
  it('starts a session in the repository with project and local settings only', async () => {
    const { cli, calls } = setup();
    expect(await cli.start(REPO, 'fix-tests', 'Fix the tests', 'plan')).toBe(0);
    expect(calls).toHaveLength(1);
    const { options, prompts } = calls[0]!;
    expect(options).toMatchObject({
      cwd: '/work/app',
      permissionMode: 'plan',
      settingSources: ['project', 'local'],
    });
    expect(options.resume).toBeUndefined();
    expect(prompts).toEqual(['Fix the tests']);
    await eventually(async () => (await cli.agents())?.[0]?.status === 'idle');
    expect(await cli.agents()).toEqual([
      {
        sessionId: 'sdk-1',
        cwd: '/work/app',
        kind: 'background',
        state: 'working',
        status: 'idle',
        name: 'fix-tests',
      },
    ]);
    cli.close();
    expect(calls[0]!.closed).toBe(true);
  });

  it('leaves the permission mode out when none is named', async () => {
    const { cli, calls } = setup();
    await cli.start(REPO, 'a', 'Go');
    expect('permissionMode' in calls[0]!.options).toBe(false);
    cli.close();
  });

  it('refuses to start without ANTHROPIC_API_KEY', async () => {
    const { cli, calls, log } = setup({ apiKeySet: false });
    expect(await cli.start(REPO, 'a', 'Go')).toBe(1);
    expect(calls).toHaveLength(0);
    expect(log).toHaveBeenCalledWith('sdk_no_api_key', {});
  });

  it('refuses to start when the SDK is not installed', async () => {
    const { cli, log } = setup({ sdk: () => Promise.resolve(undefined) });
    expect(await cli.start(REPO, 'a', 'Go')).toBe(1);
    expect(log).toHaveBeenCalledWith('sdk_unavailable', {});
  });

  it.each(['none', '/login managed key', 'apiKeyHelper'])(
    'stops a session whose credential source is %s (SDK-O)',
    async (source) => {
      const sdk = fakeSdk({ apiKeySource: source });
      const { cli, calls, log } = setup({}, sdk);
      expect(await cli.start(REPO, 'a', 'Go')).toBe(1);
      expect(log).toHaveBeenCalledWith('sdk_auth_refused', { api_key_source: source });
      await waitFor(() => calls[0]!.closed);
      expect(await cli.agents()).toEqual([]);
    },
  );

  it('fails a start that sees no init in time', async () => {
    const sdk: AgentSdk = {
      query: () => {
        const call: QueryCall = {
          options: {} as SdkQueryOptions,
          prompts: [],
          closed: false,
          end: () => {},
        };
        calls.push(call);
        return {
          close: () => (call.closed = true),
          // A query that never says anything.
          [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
        };
      },
    };
    const calls: QueryCall[] = [];
    const { cli, log, time } = setup({ sdk: () => Promise.resolve(sdk) });
    const started = cli.start(REPO, 'a', 'Go');
    await waitFor(() => time.active() === 1);
    time.advance(SDK_START_TIMEOUT_MS);
    expect(await started).toBe(1);
    expect(log).toHaveBeenCalledWith('sdk_start_timeout', {});
    expect(calls[0]!.closed).toBe(true);
  });

  it('marks a session failed when the query throws', async () => {
    const sdk = fakeSdk(() => {
      throw new Error('boom');
    });
    const { cli, log } = setup({}, sdk);
    expect(await cli.start(REPO, 'a', 'Go')).toBe(1);
    expect(log).toHaveBeenCalledWith('sdk_session_failed', { session_id: null });
  });

  it('sends a follow-up into the live query', async () => {
    const { cli, calls } = setup();
    await cli.start(REPO, 'a', 'First');
    expect(await cli.resume(REPO, 'sdk-1', 'Second')).toBe(0);
    await waitFor(() => calls[0]!.prompts.length === 2);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompts).toEqual(['First', 'Second']);
    cli.close();
  });

  it('resumes a session whose query ended, keeping its name and mode', async () => {
    const { cli, calls } = setup();
    await cli.start(REPO, 'named', 'First', 'acceptEdits');
    calls[0]!.end();
    await eventually(async () => (await cli.agents())?.[0]?.state === 'done');
    expect(await cli.resume(REPO, 'sdk-1', 'Again')).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.options).toMatchObject({ resume: 'sdk-1', permissionMode: 'acceptEdits' });
    expect(calls[1]!.prompts).toEqual(['Again']);
    expect((await cli.agents())?.find((row) => row.state === 'working')?.name).toBe('named');
    cli.close();
  });

  it('resumes a CLI session through the SDK and never through the CLI', async () => {
    const start = vi.fn(() => Promise.resolve(0));
    const resume = vi.fn(() => Promise.resolve(0));
    const { cli, calls } = setup({ cli: { ...fakeCli([]), start, resume } });
    expect(await cli.resume(OTHER, 'cli-session', 'Go on')).toBe(0);
    expect(calls[0]!.options).toMatchObject({ cwd: '/work/lib', resume: 'cli-session' });
    expect(resume).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    cli.close();
  });

  it('starts a new query for a live session asked from another repository', async () => {
    const { cli, calls } = setup();
    await cli.start(REPO, 'a', 'First');
    await cli.resume(OTHER, 'sdk-1', 'Elsewhere');
    expect(calls).toHaveLength(2);
    cli.close();
  });

  it('merges its sessions after the CLI roster', async () => {
    const row: RosterEntry = {
      sessionId: 'cli-1',
      cwd: '/work/app',
      kind: 'interactive',
      state: 'working',
      status: 'idle',
      name: undefined,
    };
    const { cli } = setup({ cli: fakeCli([row]) });
    expect(await cli.agents()).toEqual([row]);
    await cli.start(REPO, 'a', 'Go');
    expect((await cli.agents())?.map((entry) => entry.sessionId)).toEqual(['cli-1', 'sdk-1']);
    cli.close();
  });

  it('lists its sessions when the CLI roster cannot be read', async () => {
    const { cli } = setup({ cli: fakeCli(undefined) });
    expect(await cli.agents()).toBeUndefined();
    await cli.start(REPO, 'a', 'Go');
    expect((await cli.agents())?.map((entry) => entry.sessionId)).toEqual(['sdk-1']);
    cli.close();
  });

  it('dispatches a permission as a PermissionRequest and answers with the decision', async () => {
    const { cli, calls, dispatched, reply } = setup();
    await cli.start(REPO, 'a', 'Go');
    reply({
      status: 200,
      body: {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'deny', message: 'No', interrupt: false },
        },
      },
    });
    const suggestions = [{ type: 'addRules' }];
    const result = await calls[0]!.options.canUseTool(
      'Bash',
      { command: 'ls' },
      { ...PERMISSION, suggestions },
    );
    expect(result).toEqual({ behavior: 'deny', message: 'No' });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.input).toEqual({
      hook_event_name: 'PermissionRequest',
      session_id: 'sdk-1',
      cwd: '/work/app',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      permission_suggestions: suggestions,
    });
    expect(dispatched[0]!.context).toMatchObject({
      hookTimeoutMs: 300_000,
      agent: 'claude-code',
      origin: 'sdk',
    });
    cli.close();
  });

  it('offers no "always" when the SDK suppresses the rule', async () => {
    const { cli, calls, dispatched } = setup();
    await cli.start(REPO, 'a', 'Go');
    await calls[0]!.options.canUseTool(
      'Bash',
      {},
      { ...PERMISSION, suggestions: [{ type: 'addRules' }], suppressAlwaysAllowRule: true },
    );
    expect('permission_suggestions' in dispatched[0]!.input).toBe(false);
    cli.close();
  });

  it('denies a permission with no decision instead of handing it off', async () => {
    const { cli, calls } = setup();
    await cli.start(REPO, 'a', 'Go');
    expect(await calls[0]!.options.canUseTool('Bash', {}, PERMISSION)).toEqual({
      behavior: 'deny',
      message: NO_DECISION_MESSAGE,
    });
    cli.close();
  });

  it('denies an AskUserQuestion permission without dispatching it', async () => {
    const { cli, calls, dispatched } = setup();
    await cli.start(REPO, 'a', 'Go');
    expect(await calls[0]!.options.canUseTool('AskUserQuestion', {}, PERMISSION)).toEqual({
      behavior: 'deny',
      message: NO_DECISION_MESSAGE,
    });
    expect(dispatched).toHaveLength(0);
    cli.close();
  });

  it('holds AskUserQuestion in a PreToolUse hook and returns its output unchanged', async () => {
    const { cli, calls, dispatched, reply } = setup();
    await cli.start(REPO, 'a', 'Go');
    const [matcher] = calls[0]!.options.hooks['PreToolUse']!;
    expect(matcher).toMatchObject({ matcher: '^AskUserQuestion$', timeout: 300 });
    const body = {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    };
    reply({ status: 200, body });
    const input = { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' };
    expect(await matcher!.hooks[0]!(input, 'tool-1', PERMISSION)).toBe(body);
    expect(dispatched[0]).toMatchObject({ input, context: { hookTimeoutMs: 300_000 } });
    reply({ status: 204 });
    expect(await matcher!.hooks[0]!(input, 'tool-1', PERMISSION)).toEqual({});
    cli.close();
  });

  it('feeds every feed event through the dispatcher with the feed timeout', async () => {
    const { cli, calls, dispatched } = setup();
    await cli.start(REPO, 'a', 'Go');
    const { hooks } = calls[0]!.options;
    for (const event of FEED_EVENTS) {
      const [matcher] = hooks[event]!;
      expect(matcher).toMatchObject({ timeout: 5 });
      expect(await matcher!.hooks[0]!({ hook_event_name: event }, undefined, PERMISSION)).toEqual(
        {},
      );
    }
    expect(dispatched.map((entry) => entry.context.hookTimeoutMs)).toEqual(
      FEED_EVENTS.map(() => 5000),
    );
    cli.close();
  });

  it('marks a session done when its query ends, and closes it', async () => {
    const { cli, calls } = setup();
    await cli.start(REPO, 'a', 'Go');
    calls[0]!.end();
    await eventually(async () => (await cli.agents())?.[0]?.state === 'done');
    expect((await cli.agents())?.[0]).toMatchObject({ sessionId: 'sdk-1', status: undefined });
    expect(calls[0]!.closed).toBe(true);
  });

  it('takes version from the CLI', async () => {
    const { cli } = setup();
    expect(await cli.version()).toBe('2.1.200');
  });
});
