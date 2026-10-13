import { seededRandom } from '@remote-control/fake-claude-code';
import { describe, expect, it, vi } from 'vitest';

import type { Timer } from '../ports/timer.js';
import {
  blockingKind,
  createHookDispatcher,
  fingerprint,
  type HookInput,
} from './hook-dispatcher.js';
import { createPendingStore } from './pending-store.js';

const idleTimer: Timer = { after: () => ({ cancel: () => undefined }) };

function setup() {
  const store = createPendingStore({
    clock: { now: () => 1_000 },
    timer: idleTimer,
    random: seededRandom(3),
  });
  const seen: HookInput[] = [];
  const handler = createHookDispatcher({ store, onEvent: (input) => seen.push(input) });
  return { store, handler, seen };
}

const permission: HookInput = {
  hook_event_name: 'PermissionRequest',
  session_id: 's1',
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
};

describe('hook dispatcher', () => {
  it('classifies blocking events (D11)', () => {
    expect(blockingKind(permission)).toBe('permission');
    expect(
      blockingKind({
        hook_event_name: 'PreToolUse',
        session_id: 's',
        tool_name: 'AskUserQuestion',
      }),
    ).toBe('question');
    expect(
      blockingKind({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash' }),
    ).toBe(undefined);
    expect(blockingKind({ hook_event_name: 'Stop', session_id: 's' })).toBe(undefined);
  });

  it('fingerprints tool name and input', () => {
    expect(fingerprint(permission)).toBe('Bash\0{"command":"ls"}');
    expect(fingerprint({ hook_event_name: 'PermissionRequest', session_id: 's' })).toBe('\0null');
  });

  it('answers feed events at once with no output', async () => {
    const { handler, store, seen } = setup();
    const reply = await handler(
      { hook_event_name: 'PostToolUse', session_id: 's1' },
      { hookTimeoutMs: 5_000, signal: new AbortController().signal },
    );
    expect(reply).toEqual({ status: 204 });
    expect(store.list()).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it('returns the decision body for a resolved request', async () => {
    const { handler, store } = setup();
    const pending = handler(permission, {
      hookTimeoutMs: 1_800_000,
      signal: new AbortController().signal,
    });
    const [request] = store.list();
    expect(request).toMatchObject({ kind: 'permission', sessionId: 's1', payload: permission });
    const body = { hookSpecificOutput: { decision: { behavior: 'allow' } } };
    store.resolve(request!.id, body);
    await expect(pending).resolves.toEqual({ status: 200, body });
  });

  it('answers {} on a handoff and cancels when the hook disconnects', async () => {
    const { handler, store } = setup();
    const controller = new AbortController();
    const pending = handler(permission, { hookTimeoutMs: 1_800_000, signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toEqual({ status: 200, body: {} });
    expect(store.list()).toEqual([]);
  });

  it('answers with onDeadline at the deadline only (onExpire "deny", D10)', async () => {
    const fire: (() => void)[] = [];
    const timer: Timer = {
      after: (_ms, callback) => {
        fire.push(callback);
        return { cancel: () => undefined };
      },
    };
    const store = createPendingStore({
      clock: { now: () => 1_000 },
      timer,
      random: seededRandom(5),
    });
    const deny = { hookSpecificOutput: { decision: { behavior: 'deny' } } };
    const seen: string[] = [];
    const handler = createHookDispatcher({
      store,
      onDeadline: (request) => {
        seen.push(request.id);
        return deny;
      },
    });
    const expiring = handler(permission, {
      hookTimeoutMs: 1_800_000,
      signal: new AbortController().signal,
    });
    const [request] = store.list();
    fire[0]!();
    await expect(expiring).resolves.toEqual({ status: 200, body: deny });
    expect(seen).toEqual([request!.id]);

    const controller = new AbortController();
    const disconnected = handler(permission, {
      hookTimeoutMs: 1_800_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(disconnected).resolves.toEqual({ status: 200, body: {} });
    expect(seen).toHaveLength(1);
  });

  it('AC: while paused a held request is answered at once with no decision (M1-03)', async () => {
    const store = createPendingStore({
      clock: { now: () => 1_000 },
      timer: idleTimer,
      random: seededRandom(6),
    });
    const added: string[] = [];
    let paused = true;
    const handler = createHookDispatcher({
      store: {
        ...store,
        register: (input) => {
          added.push(input.kind);
          return store.register(input);
        },
      },
      paused: () => Promise.resolve(paused),
    });
    const context = { hookTimeoutMs: 1_800_000, signal: new AbortController().signal };
    const question: HookInput = {
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [] },
    };
    await expect(handler(permission, context)).resolves.toEqual({ status: 200, body: {} });
    await expect(handler(question, context)).resolves.toEqual({ status: 200, body: {} });
    // Never registered: no phone sees it, no doorbell rings.
    expect(added).toEqual([]);
    expect(store.list()).toEqual([]);
    // Feed events are unaffected.
    await expect(handler({ hook_event_name: 'Stop', session_id: 's1' }, context)).resolves.toEqual({
      status: 204,
    });

    // `remotectl resume`: the next hook is held again, without a restart.
    paused = false;
    const held = handler(permission, context);
    await vi.waitFor(() => expect(store.list()).toHaveLength(1));
    expect(added).toEqual(['permission']);
    store.releaseAll('shutdown');
    await expect(held).resolves.toEqual({ status: 200, body: {} });
  });

  it('holds the request when the pause check fails', async () => {
    const store = createPendingStore({
      clock: { now: () => 1_000 },
      timer: idleTimer,
      random: seededRandom(7),
    });
    const handler = createHookDispatcher({
      store,
      paused: () => Promise.reject(new Error('EACCES')),
    });
    const held = handler(permission, {
      hookTimeoutMs: 1_800_000,
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(store.list()).toHaveLength(1));
    const body = { hookSpecificOutput: { decision: { behavior: 'allow' } } };
    store.resolve(store.list()[0]!.id, body);
    await expect(held).resolves.toEqual({ status: 200, body });
  });

  it('hands off at once when the signal is already aborted', async () => {
    const { handler } = createHookDispatcherWithoutListener();
    const controller = new AbortController();
    controller.abort();
    await expect(
      handler(permission, { hookTimeoutMs: 1_800_000, signal: controller.signal }),
    ).resolves.toEqual({ status: 200, body: {} });
  });
});

function createHookDispatcherWithoutListener() {
  const store = createPendingStore({
    clock: { now: () => 1_000 },
    timer: idleTimer,
    random: seededRandom(4),
  });
  return { handler: createHookDispatcher({ store }) };
}
