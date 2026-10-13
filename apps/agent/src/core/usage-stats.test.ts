import { MAX_HISTORY_PROJECTS } from '@remote-control/protocol';
import { describe, expect, it } from 'vitest';

import {
  MAX_OPEN_TURNS,
  NO_PROJECT,
  activeTimeText,
  createActivityTracker,
  decisionStat,
  emptyStats,
  formatStats,
  isSessionStart,
  parseStats,
  recordStats,
  statsHistory,
  statsSummary,
  totalStats,
  type ProjectStats,
} from './usage-stats.js';

const counts = (fields: Partial<ProjectStats>): ProjectStats => ({
  approvals: 0,
  denials: 0,
  sessionsStarted: 0,
  toolCalls: 0,
  activeMs: 0,
  lastActiveAt: 1_000,
  ...fields,
});

describe('usage stats', () => {
  it('counts per project and keeps the latest activity', () => {
    let stats = emptyStats();
    stats = recordStats(stats, 'api', { approvals: 1 }, 1_000);
    stats = recordStats(stats, 'api', { approvals: 1, toolCalls: 3 }, 3_000);
    stats = recordStats(stats, 'api', { denials: 1 }, 2_000);
    stats = recordStats(stats, 'web', { sessionsStarted: 1, activeMs: 90_000 }, 1_000);
    stats = recordStats(stats, undefined, { denials: 1 }, 1_000);
    expect(stats).toEqual({
      version: 2,
      projects: {
        api: counts({ approvals: 2, denials: 1, toolCalls: 3, lastActiveAt: 3_000 }),
        web: counts({ sessionsStarted: 1, activeMs: 90_000 }),
        [NO_PROJECT]: counts({ denials: 1 }),
      },
    });
    expect(totalStats(stats)).toEqual(
      counts({
        approvals: 2,
        denials: 2,
        sessionsStarted: 1,
        toolCalls: 3,
        activeMs: 90_000,
        lastActiveAt: 3_000,
      }),
    );
  });

  it('totals counters that were never active', () => {
    const stats = parseStats(
      '{"version":1,"projects":{"a":{"approvals":1,"denials":0,"sessionsStarted":0}}}',
    )!;
    expect(totalStats(stats).lastActiveAt).toBeNull();
    expect(totalStats(recordStats(stats, 'b', {}, 5)).lastActiveAt).toBe(5);
  });

  it('does not mutate the input and treats a prototype key as a plain project', () => {
    const before = emptyStats();
    const after = recordStats(before, 'constructor', { approvals: 1 }, 1_000);
    expect(before.projects).toEqual({});
    expect(after.projects['constructor']).toEqual(counts({ approvals: 1 }));
  });

  it('round-trips through JSON, upgrades version 1 and refuses anything else', () => {
    const stats = recordStats(emptyStats(), 'api', { approvals: 1 }, 1_000);
    expect(parseStats(JSON.stringify(stats))).toEqual(stats);
    expect(
      parseStats('{"version":1,"projects":{"a":{"approvals":2,"denials":1,"sessionsStarted":3}}}'),
    ).toEqual({
      version: 2,
      projects: { a: counts({ approvals: 2, denials: 1, sessionsStarted: 3, lastActiveAt: null }) },
    });
    expect(parseStats('not json')).toBeUndefined();
    expect(parseStats('{"version":3,"projects":{}}')).toBeUndefined();
    expect(
      parseStats('{"version":1,"projects":{"a":{"approvals":-1,"denials":0,"sessionsStarted":0}}}'),
    ).toBeUndefined();
  });

  it('formats a status summary', () => {
    expect(formatStats(emptyStats())).toEqual(['(none yet)']);
    let stats = recordStats(emptyStats(), 'web', { sessionsStarted: 1, toolCalls: 1 }, 1);
    stats = recordStats(stats, 'api', { approvals: 1, activeMs: 3_900_000 }, 1);
    expect(formatStats(stats)).toEqual([
      '1 approved, 0 denied, 1 session, 1 tool call, 1 h 5 min active',
      '  api  1 approved, 0 denied, 0 sessions, 0 tool calls, 1 h 5 min active',
      '  web  0 approved, 0 denied, 1 session, 1 tool call, under a minute active',
    ]);
    expect(statsSummary(counts({ approvals: 3, denials: 2, sessionsStarted: 4 }))).toBe(
      '3 approved, 2 denied, 4 sessions, 0 tool calls, under a minute active',
    );
  });

  it('writes active time in minutes and hours', () => {
    expect(activeTimeText(59_999)).toBe('under a minute');
    expect(activeTimeText(12 * 60_000)).toBe('12 min');
    expect(activeTimeText(2 * 3_600_000)).toBe('2 h');
    expect(activeTimeText(2 * 3_600_000 + 5 * 60_000)).toBe('2 h 5 min');
  });

  it('lists history most recently active first, then by name, capped', () => {
    let stats = parseStats(
      '{"version":1,"projects":{"old":{"approvals":1,"denials":2,"sessionsStarted":3}}}',
    )!;
    stats = recordStats(stats, 'b', { toolCalls: 4, activeMs: 5 }, 10);
    stats = recordStats(stats, 'a', {}, 10);
    stats = recordStats(stats, 'new', {}, 20);
    expect(statsHistory(stats)).toEqual([
      {
        project: 'new',
        sessions: 0,
        toolCalls: 0,
        approvals: 0,
        denials: 0,
        activeMs: 0,
        lastActiveAt: 20,
      },
      {
        project: 'a',
        sessions: 0,
        toolCalls: 0,
        approvals: 0,
        denials: 0,
        activeMs: 0,
        lastActiveAt: 10,
      },
      {
        project: 'b',
        sessions: 0,
        toolCalls: 4,
        approvals: 0,
        denials: 0,
        activeMs: 5,
        lastActiveAt: 10,
      },
      {
        project: 'old',
        sessions: 3,
        toolCalls: 0,
        approvals: 1,
        denials: 2,
        activeMs: 0,
        lastActiveAt: null,
      },
    ]);
    let many = emptyStats();
    for (let i = 0; i <= MAX_HISTORY_PROJECTS; i++)
      many = recordStats(many, `p${String(i)}`, {}, i);
    const history = statsHistory(many);
    expect(history).toHaveLength(MAX_HISTORY_PROJECTS);
    expect(history[0]!.project).toBe(`p${String(MAX_HISTORY_PROJECTS)}`);
    expect(history.some((entry) => entry.project === 'p0')).toBe(false);
  });
});

describe('what is counted', () => {
  const hook = (fields: Record<string, unknown>) => ({
    hook_event_name: 'SessionStart',
    session_id: 's1',
    ...fields,
  });

  it('counts a new session, not a resumed, cleared or compacted one', () => {
    expect(isSessionStart(hook({ source: 'startup' }))).toBe(true);
    expect(isSessionStart(hook({}))).toBe(true);
    expect(isSessionStart(hook({ source: 'resume' }))).toBe(false);
    expect(isSessionStart(hook({ source: 'compact' }))).toBe(false);
    expect(isSessionStart({ hook_event_name: 'PreToolUse', session_id: 's1' })).toBe(false);
  });

  it('maps a phone decision to its counter', () => {
    expect(decisionStat('allow')).toBe('approvals');
    expect(decisionStat('deny')).toBe('denials');
    expect(decisionStat('handoff')).toBeUndefined();
  });
});

describe('activity tracker', () => {
  const event = (name: string, session = 's1', fields: Record<string, unknown> = {}) => ({
    hook_event_name: name,
    session_id: session,
    ...fields,
  });

  it('counts sessions, tool calls and turn time', () => {
    const tracker = createActivityTracker();
    expect(tracker.observe(event('SessionStart', 's1', { source: 'startup' }), 0)).toEqual({
      sessionsStarted: 1,
    });
    expect(tracker.observe(event('SessionStart', 's1', { source: 'resume' }), 0)).toBeUndefined();
    expect(tracker.observe(event('PostToolUse'), 0)).toEqual({ toolCalls: 1 });
    expect(tracker.observe(event('SubagentStop'), 0)).toBeUndefined();
    expect(tracker.observe(event('UserPromptSubmit'), 1_000)).toBeUndefined();
    expect(tracker.observe(event('UserPromptSubmit'), 2_000)).toBeUndefined();
    expect(tracker.observe(event('Stop'), 5_000)).toEqual({ activeMs: 3_000 });
    expect(tracker.observe(event('Stop'), 6_000)).toBeUndefined();
    expect(tracker.observe(event('UserPromptSubmit', 's2'), 9_000)).toBeUndefined();
    expect(tracker.observe(event('SessionEnd', 's2'), 8_000)).toEqual({ activeMs: 0 });
  });

  it('forgets the oldest open turn beyond the limit', () => {
    const tracker = createActivityTracker();
    for (let i = 0; i <= MAX_OPEN_TURNS; i++) {
      tracker.observe(event('UserPromptSubmit', `s${String(i)}`), i);
    }
    expect(tracker.observe(event('Stop', 's0'), 5_000)).toBeUndefined();
    expect(tracker.observe(event('Stop', 's1'), 5_000)).toEqual({ activeMs: 4_999 });
  });
});
