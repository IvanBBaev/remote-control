import { seededRandom } from '@remote-control/fake-claude-code';
import { describe, expect, it } from 'vitest';

import type { Timer } from '../ports/timer.js';
import {
  DEADLINE_MARGIN_MS,
  DUPLICATE_WINDOW_MS,
  RELEASED_MEMORY,
  createPendingStore,
  type PendingEvent,
  type RegisterInput,
} from './pending-store.js';

/** A clock and a timer driven by hand: `advance` fires every due callback. */
function manualTime(start = 1_760_000_000_000) {
  let now = start;
  const timers: { at: number; callback: () => void; active: boolean }[] = [];
  const timer: Timer = {
    after(ms, callback) {
      const entry = { at: now + ms, callback, active: true };
      timers.push(entry);
      return { cancel: () => (entry.active = false) };
    },
  };
  return {
    clock: { now: () => now },
    timer,
    active: () => timers.filter((entry) => entry.active).length,
    advance(ms: number) {
      now += ms;
      for (const entry of timers) {
        if (entry.active && entry.at <= now) {
          entry.active = false;
          entry.callback();
        }
      }
    },
  };
}

const T = 1_800_000;

function input(overrides: Partial<RegisterInput> = {}): RegisterInput {
  return {
    sessionId: 's1',
    kind: 'permission',
    fingerprint: 'Bash\0{"command":"ls"}',
    payload: { hook_event_name: 'PermissionRequest', session_id: 's1' },
    hookTimeoutMs: T,
    ...overrides,
  };
}

function setup() {
  const time = manualTime();
  const events: PendingEvent[] = [];
  const store = createPendingStore({
    clock: time.clock,
    timer: time.timer,
    random: seededRandom(7),
    onEvent: (event) => events.push(event),
  });
  return { time, store, events };
}

describe('PendingStore', () => {
  it('holds a request until T - 10 s and then hands off', async () => {
    const { time, store } = setup();
    const registration = store.register(input());
    expect(registration.request.id).toMatch(/^req_[0-9a-f]{24}$/);
    expect(registration.request.deadline - registration.request.createdAt).toBe(
      T - DEADLINE_MARGIN_MS,
    );
    expect(store.list()).toEqual([registration.request]);
    time.advance(T - DEADLINE_MARGIN_MS - 1);
    expect(store.get(registration.request.id)).toBe(registration.request);
    time.advance(1);
    await expect(registration.settled).resolves.toEqual({ type: 'handoff', reason: 'deadline' });
    expect(store.list()).toEqual([]);
  });

  it('settles with the decision given to resolve and cancels the deadline', async () => {
    const { time, store, events } = setup();
    const registration = store.register(input());
    const response = { hookSpecificOutput: { hookEventName: 'PermissionRequest' } };
    expect(store.resolve(registration.request.id, response)).toBe('resolved');
    await expect(registration.settled).resolves.toEqual({ type: 'decided', response });
    expect(time.active()).toBe(0);
    expect(events.map((event) => event.type)).toEqual(['added', 'removed']);
    // A decided id is gone, not "released".
    expect(store.resolve(registration.request.id, {})).toBe('unknown');
  });

  it('rejects a decision that arrives after the deadline', async () => {
    const { time, store } = setup();
    const registration = store.register(input());
    time.advance(T);
    await registration.settled;
    expect(store.resolve(registration.request.id, { allow: true })).toBe('released');
    expect(store.release(registration.request.id)).toBe('released');
    expect(store.resolve('req_unknown', {})).toBe('unknown');
    expect(store.release('req_unknown')).toBe('unknown');
  });

  it('never holds a request with a timeout below the margin', async () => {
    const { time, store } = setup();
    const registration = store.register(input({ hookTimeoutMs: 5_000 }));
    expect(registration.request.deadline).toBe(registration.request.createdAt);
    time.advance(0);
    await expect(registration.settled).resolves.toEqual({ type: 'handoff', reason: 'deadline' });
  });

  it('keeps the id of a duplicate within 2 s and hands the old wait off', async () => {
    const { time, store, events } = setup();
    const first = store.register(input());
    time.advance(DUPLICATE_WINDOW_MS);
    const second = store.register(input());
    expect(second.duplicate).toBe(true);
    expect(second.request.id).toBe(first.request.id);
    await expect(first.settled).resolves.toEqual({ type: 'handoff', reason: 'replaced' });
    expect(store.list()).toEqual([second.request]);
    // The id lives on: a decision reaches the new wait.
    expect(store.resolve(first.request.id, { ok: 1 })).toBe('resolved');
    await expect(second.settled).resolves.toEqual({ type: 'decided', response: { ok: 1 } });
    expect(events.at(-2)).toMatchObject({ type: 'added', duplicate: true });
  });

  it('gives a repeat after 2 s or with other content a new id; one in flight per slot', async () => {
    const { time, store } = setup();
    const first = store.register(input());
    time.advance(DUPLICATE_WINDOW_MS + 1);
    const late = store.register(input());
    expect(late.duplicate).toBe(false);
    expect(late.request.id).not.toBe(first.request.id);
    await expect(first.settled).resolves.toEqual({ type: 'handoff', reason: 'replaced' });
    expect(store.resolve(first.request.id, {})).toBe('released');

    const other = store.register(input({ fingerprint: 'Bash\0{"command":"pwd"}' }));
    expect(other.duplicate).toBe(false);
    await expect(late.settled).resolves.toEqual({ type: 'handoff', reason: 'replaced' });
    expect(store.list()).toEqual([other.request]);
  });

  it('keeps separate slots per session and per kind', () => {
    const { store } = setup();
    store.register(input());
    store.register(input({ sessionId: 's2' }));
    store.register(input({ kind: 'question' }));
    expect(store.list()).toHaveLength(3);
  });

  it('cancel hands off once and never touches a request that replaced it', async () => {
    const { store } = setup();
    const first = store.register(input());
    first.cancel('disconnected');
    await expect(first.settled).resolves.toEqual({ type: 'handoff', reason: 'disconnected' });
    first.cancel('shutdown');

    const a = store.register(input());
    const b = store.register(input());
    a.cancel('disconnected');
    expect(store.list()).toEqual([b.request]);
  });

  it('release and releaseAll hand every request back to the terminal', async () => {
    const { store } = setup();
    const a = store.register(input());
    const b = store.register(input({ sessionId: 's2' }));
    const c = store.register(input({ sessionId: 's3' }));
    expect(store.release(a.request.id)).toBe('resolved');
    await expect(a.settled).resolves.toEqual({ type: 'handoff', reason: 'released' });
    store.releaseAll('shutdown');
    await expect(b.settled).resolves.toEqual({ type: 'handoff', reason: 'shutdown' });
    await expect(c.settled).resolves.toEqual({ type: 'handoff', reason: 'shutdown' });
    expect(store.list()).toEqual([]);
  });

  it('remembers a bounded number of released ids', () => {
    const { store } = setup();
    const first = store.register(input({ sessionId: 'first' }));
    first.cancel('disconnected');
    for (let i = 0; i < RELEASED_MEMORY; i++) {
      store.register(input({ sessionId: `s${i}` })).cancel('disconnected');
    }
    expect(store.resolve(first.request.id, {})).toBe('unknown');
  });

  it('works without an event listener', () => {
    const time = manualTime();
    const store = createPendingStore({
      clock: time.clock,
      timer: time.timer,
      random: seededRandom(),
    });
    const registration = store.register(input());
    expect(store.resolve(registration.request.id, {})).toBe('resolved');
  });
});
