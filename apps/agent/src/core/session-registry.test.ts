import { describe, expect, it, vi } from 'vitest';

import type { RosterEntry } from '../ports/claude-cli.js';
import { manualTime } from '../testing/manual-time.js';
import { createSessionRegistry, ROSTER_POLL_MS, SESSION_STALE_MS } from './session-registry.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function row(overrides: Partial<RosterEntry> = {}): RosterEntry {
  return {
    sessionId: A,
    cwd: '/repo',
    kind: 'background',
    state: 'working',
    status: 'busy',
    name: 'rc-repo-00000000',
    ...overrides,
  };
}

/** `null`: a roster that cannot be read. */
function harness(roster: readonly RosterEntry[] | null = []) {
  const time = manualTime();
  const onChange = vi.fn();
  const cli = { rows: roster ?? undefined, agents: vi.fn(() => Promise.resolve(cli.rows)) };
  const registry = createSessionRegistry({
    clock: time.clock,
    timer: time.timer,
    cli,
    onChange,
  });
  return { time, onChange, cli, registry };
}

describe('createSessionRegistry', () => {
  it('learns a session from a hook and remembers its folder', () => {
    const { registry, onChange } = harness();
    expect(registry.seenCwd('/repo')).toBe(false);
    registry.observe(A, '/repo', false);
    expect(registry.get(A)).toMatchObject({ id: A, cwd: '/repo', state: 'working' });
    expect(registry.get(A)?.kind).toBeUndefined();
    expect(registry.seenCwd('/repo')).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);

    // The same hook again changes nothing a phone shows.
    registry.observe(A, '/repo', false);
    expect(onChange).toHaveBeenCalledTimes(1);

    registry.observe(A, '/repo', true);
    expect(registry.get(A)?.state).toBe('ended');
    // A hook after the end means the session came back.
    registry.observe(A, '/repo', false);
    expect(registry.get(A)?.state).toBe('working');
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('keeps a known state on a later hook', async () => {
    const { registry, cli } = harness([row({ status: 'waiting' })]);
    await registry.refresh();
    expect(registry.get(A)?.state).toBe('waiting');
    registry.observe(A, '/repo', false);
    expect(registry.get(A)).toMatchObject({ state: 'waiting', name: 'rc-repo-00000000' });
    expect(cli.agents).toHaveBeenCalledTimes(1);
  });

  it('maps roster rows to session states', async () => {
    const { registry, cli } = harness();
    const cases: [Partial<RosterEntry>, string][] = [
      [{ state: 'working', status: 'busy' }, 'working'],
      [{ state: 'working', status: undefined }, 'working'],
      [{ state: 'working', status: 'waiting' }, 'waiting'],
      [{ state: 'working', status: 'idle' }, 'idle'],
      [{ state: 'blocked', status: 'busy' }, 'waiting'],
      [{ state: 'done' }, 'ended'],
      [{ state: 'failed' }, 'ended'],
      [{ state: 'stopped' }, 'ended'],
    ];
    registry.observe(A, '/repo', false);
    for (const [fields, state] of cases) {
      cli.rows = [row(fields)];
      await registry.refresh();
      expect(registry.get(A)?.state, JSON.stringify(fields)).toBe(state);
    }
  });

  it('adds only live sessions from the roster but updates known ones', async () => {
    const { registry, onChange } = harness([
      row(),
      row({ sessionId: B, state: 'done', name: 'old' }),
    ]);
    expect(await registry.refresh()).toHaveLength(2);
    expect(registry.list().map((session) => session.id)).toEqual([A]);
    expect(registry.get(A)).toMatchObject({ kind: 'background', name: 'rc-repo-00000000' });
    expect(onChange).toHaveBeenCalledTimes(1);

    // Nothing changed: no notification.
    await registry.refresh();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('keeps the last seen time of a session that ended in the roster', async () => {
    const { registry, cli, time } = harness([row()]);
    await registry.refresh();
    const seenAt = registry.get(A)!.seenAt;
    time.advance(1_000);
    cli.rows = [row({ state: 'done', name: undefined })];
    await registry.refresh();
    expect(registry.get(A)).toMatchObject({ state: 'ended', seenAt, name: 'rc-repo-00000000' });
  });

  it('survives a roster that cannot be read', async () => {
    const { registry, onChange } = harness(null);
    registry.observe(A, '/repo', false);
    expect(await registry.refresh()).toBeUndefined();
    expect(registry.get(A)?.state).toBe('working');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('polls the roster only while sessions are known, and stops on close', async () => {
    const { registry, cli, time } = harness([row()]);
    time.advance(ROSTER_POLL_MS * 3);
    expect(cli.agents).not.toHaveBeenCalled();

    registry.observe(A, '/repo', false);
    expect(time.active()).toBe(1);
    time.advance(ROSTER_POLL_MS);
    await vi.waitFor(() => expect(time.active()).toBe(1));
    expect(cli.agents).toHaveBeenCalledTimes(1);
    time.advance(ROSTER_POLL_MS);
    await vi.waitFor(() => expect(cli.agents).toHaveBeenCalledTimes(2));

    registry.close();
    expect(time.active()).toBe(0);
    registry.observe(B, '/repo', false);
    expect(time.active()).toBe(0);
    registry.close();
  });

  it('drops a session silent for a day', async () => {
    const { registry, time, onChange } = harness(null);
    registry.observe(A, '/repo', false);
    registry.close();
    time.advance(SESSION_STALE_MS - 1);
    expect(registry.list()).toHaveLength(1);
    time.advance(1);
    expect(registry.list()).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(registry.list()).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(2);

    registry.observe(B, '/repo', false);
    time.advance(SESSION_STALE_MS);
    await registry.refresh();
    expect(registry.get(B)).toBeUndefined();
  });

  it('takes custom poll and stale periods', () => {
    const time = manualTime();
    const agents = vi.fn(() => Promise.resolve([]));
    const registry = createSessionRegistry({
      clock: time.clock,
      timer: time.timer,
      cli: { agents },
      pollMs: 5,
      staleMs: 10,
    });
    registry.observe(A, '/repo', false);
    time.advance(5);
    expect(agents).toHaveBeenCalledTimes(1);
    time.advance(10);
    expect(registry.list()).toEqual([]);
    registry.close();
  });
});
