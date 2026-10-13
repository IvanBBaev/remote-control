import type { ApprovalRequest } from '@remote-control/protocol';
import { describe, expect, it } from 'vitest';

import { createRealtimeStore } from './realtime-store.js';
import type { RequestView } from './realtime-store.js';
import {
  MAX_COUNTED,
  NO_PROJECT,
  browserUsageStorage,
  countUsage,
  createUsageStatsStore,
  emptyUsageStats,
  machineUsage,
  memoryUsageStorage,
  parseUsageStats,
  trackUsage,
  usageSummary,
} from './usage-stats.js';

const AGENT = 'agent-1';

function view(id: string, change: Partial<ApprovalRequest> = {}): RequestView {
  return {
    machineId: AGENT,
    request: {
      id,
      sessionId: 'sess-1',
      requestHash: 'a'.repeat(64),
      toolLabel: 'Run a command',
      toolName: 'Bash',
      content: 'pnpm test',
      truncated: false,
      suggestions: [],
      expiresAt: 0,
      alwaysSupported: false,
      project: 'api',
      ...change,
    },
    deadline: 0,
    status: 'pending',
  };
}

const accepted = (v: RequestView): RequestView => ({
  ...v,
  status: 'resolved',
  result: { t: 'decision_result', requestId: v.request.id, result: 'accepted' },
});

describe('usage counters', () => {
  it('counts approvals, denials and sessions per computer and project, each key once', () => {
    let stats = emptyUsageStats();
    const event = { machineId: AGENT, project: 'api', field: 'approvals', key: 'k1' } as const;
    stats = countUsage(stats, event);
    expect(countUsage(stats, event)).toBe(stats);
    stats = countUsage(stats, { ...event, field: 'denials', key: 'k2' });
    stats = countUsage(stats, { ...event, project: undefined, field: 'sessions', key: 'k3' });
    expect(stats.machines).toEqual({
      [AGENT]: {
        api: { approvals: 1, denials: 1, sessions: 0 },
        [NO_PROJECT]: { approvals: 0, denials: 0, sessions: 1 },
      },
    });
    expect(machineUsage(stats, AGENT)).toEqual({ approvals: 1, denials: 1, sessions: 1 });
    expect(machineUsage(stats, 'other')).toBeUndefined();
  });

  it('forgets the oldest counted keys beyond the cap', () => {
    let stats = emptyUsageStats();
    for (let i = 0; i <= MAX_COUNTED; i += 1) {
      stats = countUsage(stats, { machineId: AGENT, project: 'p', field: 'sessions', key: `${i}` });
    }
    expect(stats.counted).toHaveLength(MAX_COUNTED);
    expect(stats.counted[0]).toBe('1');
  });

  it('summarises counts', () => {
    expect(usageSummary({ approvals: 3, denials: 1, sessions: 2 })).toBe(
      '3 approved, 1 denied, 2 sessions',
    );
    expect(usageSummary({ approvals: 0, denials: 0, sessions: 1 })).toBe(
      '0 approved, 0 denied, 1 session',
    );
  });
});

describe('stored counters', () => {
  it('round-trips a valid record and rejects anything else', () => {
    const stats = countUsage(emptyUsageStats(), {
      machineId: AGENT,
      project: 'api',
      field: 'approvals',
      key: 'k',
    });
    expect(parseUsageStats(JSON.stringify(stats))).toEqual(stats);
    const counts = { approvals: 1, denials: 0, sessions: 0 };
    for (const bad of [
      '{',
      'null',
      '[]',
      JSON.stringify({ version: 2, machines: {}, counted: [] }),
      JSON.stringify({ version: 1, machines: [], counted: [] }),
      JSON.stringify({ version: 1, machines: { a: 1 }, counted: [] }),
      JSON.stringify({
        version: 1,
        machines: { a: { p: { ...counts, approvals: -1 } } },
        counted: [],
      }),
      JSON.stringify({ version: 1, machines: { a: { p: { ...counts, extra: 0 } } }, counted: [] }),
      JSON.stringify({
        version: 1,
        machines: { a: { p: { ...counts, denials: 0.5 } } },
        counted: [],
      }),
      JSON.stringify({
        version: 1,
        machines: { a: { p: { ...counts, sessions: '1' } } },
        counted: [],
      }),
      JSON.stringify({ version: 1, machines: {}, counted: 'k' }),
      JSON.stringify({ version: 1, machines: {}, counted: [1] }),
    ]) {
      expect(parseUsageStats(bad)).toBeUndefined();
    }
  });

  it('loads from storage, falls back to empty and writes every change', () => {
    const storage = memoryUsageStorage();
    expect(createUsageStatsStore(storage).getState()).toEqual(emptyUsageStats());
    storage.write('not json');
    const store = createUsageStatsStore(storage);
    expect(store.getState()).toEqual(emptyUsageStats());
    store.setState(
      countUsage(store.getState(), { machineId: AGENT, project: 'p', field: 'sessions', key: 'k' }),
    );
    expect(createUsageStatsStore(storage).getState()).toEqual(store.getState());
  });

  it('uses localStorage and survives storage that throws or is missing', () => {
    const backing = new Map<string, string>();
    const local = browserUsageStorage(
      () =>
        ({
          getItem: (key: string) => backing.get(key) ?? null,
          setItem: (key: string, value: string) => backing.set(key, value),
        }) as unknown as Storage,
    );
    expect(local.read()).toBeNull();
    local.write('{"x":1}');
    expect(local.read()).toBe('{"x":1}');

    const missing = browserUsageStorage(() => undefined);
    expect(missing.read()).toBeNull();
    missing.write('x');

    const failing = browserUsageStorage(() => {
      throw new Error('SecurityError');
    });
    expect(failing.read()).toBeNull();
    expect(() => {
      failing.write('x');
    }).not.toThrow();
  });
});

describe('trackUsage', () => {
  it('counts each asking session once and each accepted decision once', () => {
    const realtime = createRealtimeStore();
    const stats = createUsageStatsStore(memoryUsageStorage());
    const sent = new Map<string, 'allow' | 'deny'>();
    realtime.setState({ requests: { r1: view('r1') } });
    const stop = trackUsage(realtime, stats, sent);
    expect(stats.getState().machines[AGENT]).toEqual({
      api: { approvals: 0, denials: 0, sessions: 1 },
    });

    sent.set('r1', 'allow');
    sent.set('r2', 'deny');
    realtime.setState({ requests: { r1: accepted(view('r1')), r2: view('r2') } });
    realtime.setState({ requests: { r1: accepted(view('r1')), r2: accepted(view('r2')) } });
    // An accepted result for a decision this phone did not send counts nothing.
    realtime.setState({ requests: { r3: accepted(view('r3', { sessionId: 'sess-2' })) } });
    expect(stats.getState().machines[AGENT]).toEqual({
      api: { approvals: 1, denials: 1, sessions: 2 },
    });
    expect(sent.size).toBe(0);

    stop();
    realtime.setState({ requests: { r4: view('r4', { sessionId: 'sess-3' }) } });
    expect(machineUsage(stats.getState(), AGENT)?.sessions).toBe(2);
  });

  it('does not count a rejected decision', () => {
    const realtime = createRealtimeStore();
    const stats = createUsageStatsStore(memoryUsageStorage());
    const sent = new Map<string, 'allow' | 'deny'>([['r1', 'allow']]);
    trackUsage(realtime, stats, sent);
    realtime.setState({
      requests: {
        r1: {
          ...view('r1', { project: undefined }),
          result: { t: 'decision_result', requestId: 'r1', result: 'rejected', reason: 'expired' },
        },
      },
    });
    expect(stats.getState().machines[AGENT]).toEqual({
      [NO_PROJECT]: { approvals: 0, denials: 0, sessions: 1 },
    });
    expect(sent.size).toBe(0);
  });
});
