import { seededRandom } from '@remote-control/fake-claude-code';
import { describe, expect, it } from 'vitest';

import { manualTime, waitFor } from '../testing/manual-time.js';
import { PAUSE_POLL_MS, createPauseWatch } from './pause-watch.js';
import { createPendingStore, type PendingOutcome, type RegisterInput } from './pending-store.js';

const INPUT: RegisterInput = {
  sessionId: 's1',
  kind: 'permission',
  fingerprint: 'Bash\0{}',
  payload: { hook_event_name: 'PermissionRequest', session_id: 's1' },
  hookTimeoutMs: 600_000,
};

function setup(check: () => Promise<boolean>) {
  const time = manualTime();
  const ref: { pendingChanged?: () => void } = {};
  const store = createPendingStore({
    clock: time.clock,
    timer: time.timer,
    random: seededRandom(9),
    onEvent: () => ref.pendingChanged?.(),
  });
  const watch = createPauseWatch({ store, timer: time.timer, paused: check });
  ref.pendingChanged = () => watch.pendingChanged();
  return { time, store, watch };
}

describe('pause watch (M1-03)', () => {
  it('AC: hands a held request back once the agent is paused, with no decision', async () => {
    let paused = false;
    const { time, store } = setup(() => Promise.resolve(paused));
    const outcomes: PendingOutcome[] = [];
    void store.register(INPUT).settled.then((outcome) => outcomes.push(outcome));

    time.advance(PAUSE_POLL_MS);
    await waitFor(() => time.active() === 2);
    expect(store.list()).toHaveLength(1);

    paused = true;
    time.advance(PAUSE_POLL_MS);
    await waitFor(() => outcomes.length === 1);
    expect(outcomes).toEqual([{ type: 'handoff', reason: 'paused' }]);
    // The store is empty again: nothing polls any more.
    expect(time.active()).toBe(0);
  });

  it('does not poll while nothing is held, and stops on stop()', () => {
    const { time, store, watch } = setup(() => Promise.resolve(false));
    watch.pendingChanged();
    expect(time.active()).toBe(0);
    store.register(INPUT);
    // The deadline timer and one poll.
    expect(time.active()).toBe(2);
    watch.pendingChanged();
    expect(time.active()).toBe(2);
    watch.stop();
    expect(time.active()).toBe(1);
    watch.pendingChanged();
    expect(time.active()).toBe(1);
  });

  it('keeps holding when the pause check fails', async () => {
    let calls = 0;
    const { time, store, watch } = setup(() => {
      calls += 1;
      return Promise.reject(new Error('EACCES'));
    });
    store.register(INPUT);
    time.advance(PAUSE_POLL_MS);
    await waitFor(() => calls === 1 && time.active() === 2);
    expect(store.list()).toHaveLength(1);
    watch.stop();
    time.advance(PAUSE_POLL_MS);
    expect(calls).toBe(1);
  });

  it('drops a poll that resolves after stop()', async () => {
    let resolve: (value: boolean) => void = () => undefined;
    const { time, store, watch } = setup(() => new Promise<boolean>((done) => (resolve = done)));
    store.register(INPUT);
    time.advance(PAUSE_POLL_MS);
    watch.stop();
    resolve(true);
    await waitFor(() => true);
    await new Promise<void>((done) => setImmediate(done));
    expect(store.list()).toHaveLength(1);
    expect(time.active()).toBe(1);
  });
});
