import { describe, expect, it } from 'vitest';

import { runSoak } from './soak.js';

describe('soak (M1-15)', () => {
  it(
    'allows every request through phone and agent drops, with no duplicate decision or leak',
    { timeout: 60_000 },
    async () => {
      const rounds: number[] = [];
      const report = await runSoak({
        rounds: 6,
        intervalMs: 5_000,
        tickMs: 5,
        phoneDropEvery: 2,
        agentDropEvery: 3,
        sampleEvery: 1,
        warmupRounds: 2,
        onRound: (round) => rounds.push(round),
      });

      expect(report.failures).toEqual([]);
      expect(report).toMatchObject({
        rounds: 6,
        allowed: 6,
        duplicateDecisions: 0,
        phoneReconnects: 3,
        agentDrops: 2,
        agentReconnects: 2,
        leaks: [],
      });
      expect(rounds).toEqual([1, 2, 3, 4, 5, 6]);
      expect(report.samples.map((sample) => sample.round)).toEqual([1, 2, 3, 4, 5, 6]);
      // Medians of the first and the last three samples from the end of warm-up (round 2).
      const rss = report.samples.slice(1).map((sample) => sample.rssBytes);
      const median = (values: number[]) => values.sort((a, b) => a - b)[1]!;
      expect(report.baselineRssBytes).toBe(median(rss.slice(0, 3)));
      expect(report.rssGrowthBytes).toBe(median(rss.slice(-3)) - median(rss.slice(0, 3)));
      expect(report.latencyMs.p99).toBeGreaterThan(0);
    },
  );
});
