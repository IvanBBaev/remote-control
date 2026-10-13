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
        sampleEvery: 2,
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
      expect(report.samples.map((sample) => sample.round)).toEqual([2, 4, 6]);
      expect(report.baselineRssBytes).toBe(report.samples[0]!.rssBytes);
      expect(report.rssGrowthBytes).toBe(report.samples[2]!.rssBytes - report.samples[0]!.rssBytes);
      expect(report.latencyMs.p99).toBeGreaterThan(0);
    },
  );
});
