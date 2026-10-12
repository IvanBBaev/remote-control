import { seededRandom } from '@remote-control/fake-claude-code';
import { describe, expect, it } from 'vitest';

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
