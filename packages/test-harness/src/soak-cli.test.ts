import { describe, expect, it } from 'vitest';

import { formatSoakLog, main, parseSoakArgs, verdict, type SoakIo } from './soak-cli.js';
import type { SoakOptions, SoakReport } from './soak.js';

const MB = 1024 * 1024;

function report(overrides: Partial<SoakReport> = {}): SoakReport {
  return {
    startedAt: '2026-10-14T00:00:00.000Z',
    wallMs: 86_400_000,
    rounds: 1440,
    allowed: 1440,
    failures: [],
    duplicateDecisions: 0,
    phoneReconnects: 144,
    agentDrops: 96,
    agentReconnects: 96,
    latencyMs: { p50: 12, p99: 40, max: 80 },
    samples: Array.from({ length: 144 }, (_, i) => ({
      round: (i + 1) * 10,
      atMs: (i + 1) * 600_000,
      rssBytes: 120 * MB + i * 1024,
      heapUsedBytes: 40 * MB,
    })),
    baselineRssBytes: 120 * MB,
    rssGrowthBytes: 2 * MB,
    leaks: [],
    gcExposed: true,
    ...overrides,
  };
}

function io(result: SoakReport = report()) {
  const out = {
    stderr: '',
    stdout: '',
    appended: [] as [string, string][],
    options: [] as SoakOptions[],
  };
  const deps: SoakIo = {
    stderr: (text) => (out.stderr += text),
    stdout: (text) => (out.stdout += text),
    append: (file, text) => {
      out.appended.push([file, text]);
      return Promise.resolve();
    },
    run: (options) => {
      out.options.push(options);
      options.onRound?.(9, { ...result, samples: [] });
      options.onRound?.(10, { ...result, samples: result.samples.slice(0, 1) });
      return Promise.resolve(result);
    },
  };
  return { out, deps };
}

describe('parseSoakArgs', () => {
  it('defaults to a 24 h run, one request a minute and a 20 MB limit', () => {
    expect(parseSoakArgs([])).toEqual({
      hours: 24,
      rounds: undefined,
      intervalS: 60,
      rssLimitMb: 20,
      out: undefined,
    });
  });

  it('takes rounds alone without the default hours', () => {
    expect(
      parseSoakArgs([
        '--rounds',
        '30',
        '--interval-s',
        '1',
        '--rss-limit-mb',
        '5',
        '--out',
        'x.md',
      ]),
    ).toEqual({ hours: undefined, rounds: 30, intervalS: 1, rssLimitMb: 5, out: 'x.md' });
  });

  it('rejects an unknown flag, a missing value and a non-positive number', () => {
    expect(() => parseSoakArgs(['--days', '1'])).toThrow('unknown flag --days');
    expect(() => parseSoakArgs(['--hours'])).toThrow('--hours needs a value');
    expect(() => parseSoakArgs(['--hours', '0'])).toThrow('--hours must be > 0');
    expect(() => parseSoakArgs(['--hours', 'x'])).toThrow('--hours must be > 0');
  });
});

describe('verdict', () => {
  it('passes a flat, clean run', () => {
    expect(verdict(report(), 20)).toEqual({ pass: true, reasons: [] });
  });

  it('names every reason a run fails', () => {
    expect(
      verdict(
        report({
          failures: ['round 3: timeout'],
          duplicateDecisions: 2,
          leaks: [{ source: 'relay-log', canary: 'SOAK', line: 0 }],
          agentReconnects: 97,
          rssGrowthBytes: 25 * MB,
        }),
        20,
      ).reasons,
    ).toEqual([
      '1 failed round(s)',
      '2 duplicate decision(s)',
      '1 canary leak(s)',
      'agent reconnected 97 times for 96 drops',
      'RSS grew 25.0 MB (limit 20 MB)',
    ]);
    expect(verdict(report({ rssGrowthBytes: null }), 20).reasons).toEqual([
      'no RSS baseline (run past the warm-up)',
    ]);
  });
});

describe('formatSoakLog', () => {
  it('writes the summary and at most 25 evenly spaced RSS samples', () => {
    const args = parseSoakArgs([]);
    const log = formatSoakLog(report(), args, verdict(report(), 20));

    expect(log).toMatch(/^## 2026-10-14T00:00:00.000Z — PASS\n/);
    expect(log).toContain('- Wall time 24.00 h, 1440 rounds, one request every 60 s');
    expect(log).toContain('- Allowed 1440/1440; duplicate decisions 0; canary leaks 0');
    expect(log).toContain('growth 2.0 MB (limit 20 MB)');
    const rows = log.split('\n').filter((line) => /^\| \d/.test(line));
    expect(rows).toHaveLength(25);
    expect(rows[0]).toMatch(/^\| 10 \| 0\.17 \| 120\.0 \|/);
    expect(rows.at(-1)).toMatch(/^\| 1440 \| 24\.00 \|/);
  });

  it('writes the reasons and the first failures of a failed run, and n/a without samples', () => {
    const failed = report({
      failures: ['round 1: no request on the phone'],
      samples: [],
      baselineRssBytes: null,
      rssGrowthBytes: null,
      gcExposed: false,
    });
    const log = formatSoakLog(failed, parseSoakArgs([]), verdict(failed, 20));

    expect(log).toContain('— FAIL');
    expect(log).toContain('GC exposed: no');
    expect(log).toContain('- Verdict: 1 failed round(s); no RSS baseline');
    expect(log).toContain('  - round 1: no request on the phone');
    expect(log).toContain('RSS baseline n/a, growth n/a');
    expect(log).not.toContain('| Round |');
  });
});

describe('main', () => {
  it('runs for the hours given, prints progress on sampled rounds and the log on stdout', async () => {
    const { out, deps } = io();

    expect(await main(['--hours', '0.5', '--interval-s', '30'], deps)).toBe(0);

    expect(out.options[0]).toMatchObject({ durationMs: 1_800_000, intervalMs: 30_000 });
    expect(out.options[0]).not.toHaveProperty('rounds');
    expect(out.stderr).toContain(
      'soak: round 10, 0.17 h, RSS 120.0 MB, allowed 1440, failures 0\n',
    );
    expect(out.stderr).not.toContain('round 9');
    expect(out.stderr).toMatch(/soak: PASS\n$/);
    expect(out.stdout).toContain('— PASS');
  });

  it('appends the log to --out and exits 1 on a failed verdict', async () => {
    const { out, deps } = io(report({ duplicateDecisions: 1 }));

    expect(await main(['--rounds', '5', '--out', 'soak.md'], deps)).toBe(1);

    expect(out.options[0]).toMatchObject({ rounds: 5 });
    expect(out.options[0]).not.toHaveProperty('durationMs');
    expect(out.appended).toHaveLength(1);
    expect(out.appended[0]![0]).toBe('soak.md');
    expect(out.appended[0]![1]).toMatch(/^\n## .* — FAIL/);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('soak: FAIL — 1 duplicate decision(s)');
  });

  it('exits 2 on bad arguments without running', async () => {
    const { out, deps } = io();

    expect(await main(['--bogus', '1'], deps)).toBe(2);

    expect(out.options).toEqual([]);
    expect(out.stderr).toBe('soak: unknown flag --bogus\n');
  });
});
