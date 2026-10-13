// The soak runner (M1-15):
//
//   pnpm soak [--hours 24] [--rounds N] [--interval-s 60] [--rss-limit-mb 20] [--out FILE]
//
// Runs `runSoak` in real time (one request a minute by default), prints progress to
// stderr, and appends a Markdown log entry to FILE (or prints it). Exit 0 when the
// verdict passes, 1 when it does not, 2 on bad arguments.
import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { runSoak, type SoakOptions, type SoakReport } from './soak.js';

export interface SoakArgs {
  readonly hours: number | undefined;
  readonly rounds: number | undefined;
  readonly intervalS: number;
  readonly rssLimitMb: number;
  readonly out: string | undefined;
}

export interface Verdict {
  readonly pass: boolean;
  readonly reasons: readonly string[];
}

const MB = 1024 * 1024;

/** Parses the flags; throws a `TypeError` naming the bad one. */
export function parseSoakArgs(argv: readonly string[]): SoakArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (!['--hours', '--rounds', '--interval-s', '--rss-limit-mb', '--out'].includes(flag)) {
      throw new TypeError(`unknown flag ${flag}`);
    }
    if (value === undefined) throw new TypeError(`${flag} needs a value`);
    values.set(flag, value);
  }
  const number = (flag: string): number | undefined => {
    const raw = values.get(flag);
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new TypeError(`${flag} must be > 0`);
    return parsed;
  };
  const hours = number('--hours');
  const rounds = number('--rounds');
  return {
    hours: hours === undefined && rounds === undefined ? 24 : hours,
    rounds,
    intervalS: number('--interval-s') ?? 60,
    rssLimitMb: number('--rss-limit-mb') ?? 20,
    out: values.get('--out'),
  };
}

/** The AC (03 W14, ROADMAP M1-15): RSS flat, every request allowed, no duplicate, no leak. */
export function verdict(report: SoakReport, rssLimitMb: number): Verdict {
  const reasons: string[] = [];
  if (report.failures.length > 0) reasons.push(`${String(report.failures.length)} failed round(s)`);
  if (report.duplicateDecisions > 0) {
    reasons.push(`${String(report.duplicateDecisions)} duplicate decision(s)`);
  }
  if (report.leaks.length > 0) reasons.push(`${String(report.leaks.length)} canary leak(s)`);
  if (report.agentReconnects !== report.agentDrops) {
    reasons.push(
      `agent reconnected ${String(report.agentReconnects)} times for ${String(report.agentDrops)} drops`,
    );
  }
  if (report.rssGrowthBytes === null) reasons.push('no RSS baseline (run past the warm-up)');
  else if (report.rssGrowthBytes >= rssLimitMb * MB) {
    reasons.push(`RSS grew ${mb(report.rssGrowthBytes)} MB (limit ${String(rssLimitMb)} MB)`);
  }
  return { pass: reasons.length === 0, reasons };
}

/** One log entry for `docs/verification/soak.md`. */
export function formatSoakLog(report: SoakReport, args: SoakArgs, result: Verdict): string {
  const lines = [
    `## ${report.startedAt} — ${result.pass ? 'PASS' : 'FAIL'}`,
    '',
    `- Node ${process.version}, ${process.platform}/${process.arch}; GC exposed: ${report.gcExposed ? 'yes' : 'no'}`,
    `- Wall time ${hours(report.wallMs)} h, ${String(report.rounds)} rounds, one request every ${String(args.intervalS)} s`,
    `- Allowed ${String(report.allowed)}/${String(report.rounds)}; duplicate decisions ${String(report.duplicateDecisions)}; canary leaks ${String(report.leaks.length)}`,
    `- Phone reconnects ${String(report.phoneReconnects)}; agent drops ${String(report.agentDrops)}, agent reconnects ${String(report.agentReconnects)}`,
    `- Hook round trip p50 ${String(report.latencyMs.p50)} ms, p99 ${String(report.latencyMs.p99)} ms, max ${String(report.latencyMs.max)} ms`,
    `- RSS baseline ${report.baselineRssBytes === null ? 'n/a' : `${mb(report.baselineRssBytes)} MB`}, growth ${report.rssGrowthBytes === null ? 'n/a' : `${mb(report.rssGrowthBytes)} MB`} (limit ${String(args.rssLimitMb)} MB)`,
  ];
  if (!result.pass) lines.push(`- Verdict: ${result.reasons.join('; ')}`);
  for (const failure of report.failures.slice(0, 10)) lines.push(`  - ${failure}`);
  if (report.samples.length > 0) {
    lines.push('', '| Round | Wall h | RSS MB | Heap MB |', '| ---: | ---: | ---: | ---: |');
    for (const sample of thin(report.samples, 25)) {
      lines.push(
        `| ${String(sample.round)} | ${hours(sample.atMs)} | ${mb(sample.rssBytes)} | ${mb(sample.heapUsedBytes)} |`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

export interface SoakIo {
  readonly stderr: (text: string) => void;
  readonly stdout: (text: string) => void;
  readonly append: (file: string, text: string) => Promise<void>;
  readonly run: (options: SoakOptions) => Promise<SoakReport>;
}

export async function main(argv: readonly string[], io: SoakIo): Promise<number> {
  let args: SoakArgs;
  try {
    args = parseSoakArgs(argv);
  } catch (error) {
    io.stderr(`soak: ${(error as Error).message}\n`);
    return 2;
  }
  const report = await io.run({
    ...(args.rounds !== undefined && { rounds: args.rounds }),
    ...(args.hours !== undefined && { durationMs: args.hours * 3_600_000 }),
    intervalMs: args.intervalS * 1_000,
    onRound(round, so) {
      const sample = so.samples.at(-1);
      if (sample?.round !== round) return;
      io.stderr(
        `soak: round ${String(round)}, ${hours(sample.atMs)} h, RSS ${mb(sample.rssBytes)} MB, allowed ${String(so.allowed)}, failures ${String(so.failures.length)}\n`,
      );
    },
  });
  const result = verdict(report, args.rssLimitMb);
  const log = formatSoakLog(report, args, result);
  if (args.out === undefined) io.stdout(log);
  else await io.append(args.out, `\n${log}`);
  io.stderr(`soak: ${result.pass ? 'PASS' : `FAIL — ${result.reasons.join('; ')}`}\n`);
  return result.pass ? 0 : 1;
}

function mb(bytes: number): string {
  return (bytes / MB).toFixed(1);
}

function hours(ms: number): string {
  return (ms / 3_600_000).toFixed(2);
}

/** At most `max` samples, evenly spaced, always keeping the first and the last. */
function thin<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  const step = (items.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => items[Math.round(i * step)]!);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), {
    stderr: (text) => process.stderr.write(text),
    stdout: (text) => process.stdout.write(text),
    append: (file, text) => appendFile(file, text),
    run: runSoak,
  });
}
