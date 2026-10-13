import { describe, expect, it } from 'vitest';

import {
  NO_PROJECT,
  decisionStat,
  emptyStats,
  formatStats,
  isSessionStart,
  parseStats,
  recordStat,
  statsSummary,
  totalStats,
} from './usage-stats.js';

describe('usage stats', () => {
  it('counts approvals, denials and sessions per project', () => {
    let stats = emptyStats();
    stats = recordStat(stats, 'api', 'approvals');
    stats = recordStat(stats, 'api', 'approvals');
    stats = recordStat(stats, 'api', 'denials');
    stats = recordStat(stats, 'web', 'sessionsStarted');
    stats = recordStat(stats, undefined, 'denials');
    expect(stats).toEqual({
      version: 1,
      projects: {
        api: { approvals: 2, denials: 1, sessionsStarted: 0 },
        web: { approvals: 0, denials: 0, sessionsStarted: 1 },
        [NO_PROJECT]: { approvals: 0, denials: 1, sessionsStarted: 0 },
      },
    });
    expect(totalStats(stats)).toEqual({ approvals: 2, denials: 2, sessionsStarted: 1 });
  });

  it('does not mutate the input and treats a prototype key as a plain project', () => {
    const before = emptyStats();
    const after = recordStat(before, 'constructor', 'approvals');
    expect(before.projects).toEqual({});
    expect(after.projects['constructor']).toEqual({
      approvals: 1,
      denials: 0,
      sessionsStarted: 0,
    });
  });

  it('round-trips through JSON and refuses anything else', () => {
    const stats = recordStat(emptyStats(), 'api', 'approvals');
    expect(parseStats(JSON.stringify(stats))).toEqual(stats);
    expect(parseStats('not json')).toBeUndefined();
    expect(parseStats('{"version":2,"projects":{}}')).toBeUndefined();
    expect(
      parseStats('{"version":1,"projects":{"a":{"approvals":-1,"denials":0,"sessionsStarted":0}}}'),
    ).toBeUndefined();
  });

  it('formats a status summary', () => {
    expect(formatStats(emptyStats())).toEqual(['(none yet)']);
    let stats = recordStat(emptyStats(), 'web', 'sessionsStarted');
    stats = recordStat(stats, 'api', 'approvals');
    expect(formatStats(stats)).toEqual([
      '1 approved, 0 denied, 1 session',
      '  api  1 approved, 0 denied, 0 sessions',
      '  web  0 approved, 0 denied, 1 session',
    ]);
    expect(statsSummary({ approvals: 3, denials: 2, sessionsStarted: 4 })).toBe(
      '3 approved, 2 denied, 4 sessions',
    );
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
