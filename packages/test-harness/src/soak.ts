import { setTimeout as delay } from 'node:timers/promises';

import type { ApprovalRequest } from '@remote-control/protocol';

import { createCanaries } from './canaries.js';
import { eventually } from './eventually.js';
import { permissionRequest } from './journeys/fixtures.js';
import { findLeaks, type Leak } from './privacy-gate.js';
import { scenario, type Scenario } from './scenario.js';

/**
 * The soak (M1-15, 03 W14): one relay, one agent and one phone in process, a
 * `PermissionRequest` allowed every interval, the phone's and the agent's sockets dropped
 * on a schedule, and the process RSS sampled. It looks for memory growth, broken
 * reconnects and duplicate decisions. Harness buffers (log lines, pushes, decrypted
 * messages) are taken and dropped after every round, so they do not count as growth;
 * every taken line still goes through the privacy gate.
 */
export interface SoakOptions {
  /** Rounds to run; the run also ends when `durationMs` of wall time has passed. */
  readonly rounds?: number;
  /** Wall-time budget (default: unbounded, `rounds` decides). */
  readonly durationMs?: number;
  /** Fake time between two requests (default 60 s: one request a minute). */
  readonly intervalMs?: number;
  /**
   * Wall time per fake second of the interval (default 1000: the soak runs in real time).
   * Tests pass a few ms. Each fake second is one `clock.advance`, so heartbeats and their
   * replies interleave as they would on wall time.
   */
  readonly tickMs?: number;
  /** Drop and reconnect the phone's socket every this many rounds (0: never; default 10). */
  readonly phoneDropEvery?: number;
  /** Drop the agent's socket at the relay every this many rounds (0: never; default 15). */
  readonly agentDropEvery?: number;
  /** Sample RSS every this many rounds (default 10). */
  readonly sampleEvery?: number;
  /** Rounds before the RSS baseline is taken (default 10). */
  readonly warmupRounds?: number;
  /** Called after every round with its number (1-based); progress output for the CLI. */
  readonly onRound?: (round: number, report: SoakReport) => void;
}

export interface RssSample {
  readonly round: number;
  /** Wall ms since the start of the run. */
  readonly atMs: number;
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
}

export interface SoakReport {
  readonly startedAt: string;
  readonly wallMs: number;
  readonly rounds: number;
  readonly allowed: number;
  /** Rounds whose hook did not answer `allow`, with the reason. */
  readonly failures: readonly string[];
  /** `decision_result` messages beyond the first per request id. */
  readonly duplicateDecisions: number;
  readonly phoneReconnects: number;
  readonly agentDrops: number;
  /** Agent sockets the relay accepted during the run; more than `agentDrops` is a flap. */
  readonly agentReconnects: number;
  /** Wall ms from firing the hook to its answer, per round. */
  readonly latencyMs: { readonly p50: number; readonly p99: number; readonly max: number };
  readonly samples: readonly RssSample[];
  /** RSS at the end of warm-up; the last sample's growth is measured against it. */
  readonly baselineRssBytes: number | null;
  readonly rssGrowthBytes: number | null;
  readonly leaks: readonly Leak[];
  readonly gcExposed: boolean;
}

const DEFAULTS = {
  intervalMs: 60_000,
  tickMs: 1_000,
  phoneDropEvery: 10,
  agentDropEvery: 15,
  sampleEvery: 10,
  warmupRounds: 10,
};

/** The close code the relay uses when it restarts (RFC 6455 1012): the agent reconnects. */
const SERVICE_RESTART = 1012;

export async function runSoak(options: SoakOptions = {}): Promise<SoakReport> {
  const config = { ...DEFAULTS, ...options };
  const rounds = options.rounds ?? Number.POSITIVE_INFINITY;
  const deadline =
    options.durationMs === undefined
      ? Number.POSITIVE_INFINITY
      : performance.now() + options.durationMs;
  if (!Number.isFinite(rounds) && !Number.isFinite(deadline)) {
    throw new TypeError('soak: pass rounds or durationMs');
  }
  const gc = (globalThis as { gc?: () => void }).gc;
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const canaries = createCanaries('SOAK');
  const running = await scenario({ canaries, push: true });
  // One payload for every round: its canaries are minted once, so the scan stays fixed.
  const input = permissionRequest(canaries);

  const state = {
    round: 0,
    allowed: 0,
    failures: [] as string[],
    phoneReconnects: 0,
    agentDrops: 0,
    agentOpens: 0,
    latencies: [] as number[],
    samples: [] as RssSample[],
    baseline: null as number | null,
    leaks: [] as Leak[],
  };
  const decisions = new Map<string, number>();
  const decided = new Set<string>();

  const report = (): SoakReport => {
    const last = state.samples.at(-1);
    return {
      startedAt,
      wallMs: Math.round(performance.now() - started),
      rounds: state.round,
      allowed: state.allowed,
      failures: [...state.failures],
      duplicateDecisions: [...decisions.values()].reduce((sum, n) => sum + Math.max(0, n - 1), 0),
      phoneReconnects: state.phoneReconnects,
      agentDrops: state.agentDrops,
      agentReconnects: state.agentOpens,
      latencyMs: percentiles(state.latencies),
      samples: [...state.samples],
      baselineRssBytes: state.baseline,
      rssGrowthBytes:
        state.baseline === null || last === undefined ? null : last.rssBytes - state.baseline,
      leaks: [...state.leaks],
      gcExposed: gc !== undefined,
    };
  };

  try {
    // The setup's lines are scanned too; its sockets (pairing, then `run`) are not counted.
    drain(running, canaries.all(), state, decisions);
    state.agentOpens = 0;
    while (state.round < rounds && performance.now() < deadline) {
      state.round += 1;
      await oneRound(running, input, state, decided);
      drain(running, canaries.all(), state, decisions);

      if (every(config.phoneDropEvery, state.round)) {
        await reconnectPhone(running);
        state.phoneReconnects += 1;
      }
      const dropAgent = every(config.agentDropEvery, state.round);
      const opensBefore = state.agentOpens;
      if (dropAgent) {
        running.relay.drop(running.phone.userId, running.agentDeviceId, SERVICE_RESTART);
        state.agentDrops += 1;
      }
      await idle(running, config.intervalMs, config.tickMs);
      drain(running, canaries.all(), state, decisions);
      if (dropAgent) await awaitAgentBack(running, opensBefore, state, decisions, canaries.all());

      if (state.round === config.warmupRounds || every(config.sampleEvery, state.round)) {
        gc?.();
        const memory = process.memoryUsage();
        state.samples.push({
          round: state.round,
          atMs: Math.round(performance.now() - started),
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
        });
        if (state.round === config.warmupRounds) state.baseline = memory.rss;
      }
      options.onRound?.(state.round, report());
    }
    return report();
  } finally {
    await running.close();
  }
}

/** Fires the request, waits for it on the phone, allows it and checks the hook's answer. */
async function oneRound(
  running: Scenario,
  input: Record<string, unknown>,
  state: { round: number; allowed: number; failures: string[]; latencies: number[] },
  decided: Set<string>,
): Promise<void> {
  const fired = performance.now();
  const hook = running.agent.fire(input);
  try {
    let request: ApprovalRequest | undefined;
    await eventually(
      () => {
        request = running.phone
          .of('request')
          .find((candidate) => !decided.has(candidate.request.id))?.request;
        return request !== undefined;
      },
      `round ${String(state.round)}: no request on the phone`,
    );
    decided.add(request!.id);
    await running.phone.decide('allow', request!);
    const result = await hook;
    state.latencies.push(performance.now() - fired);
    const behavior = (
      result.output as { hookSpecificOutput?: { decision?: { behavior?: string } } } | undefined
    )?.hookSpecificOutput?.decision?.behavior;
    if (behavior === 'allow') state.allowed += 1;
    else state.failures.push(`round ${String(state.round)}: hook answered ${result.stdout}`);
  } catch (error) {
    state.failures.push(`round ${String(state.round)}: ${(error as Error).message}`);
    // Let the hook settle (deny at its deadline) before the next round.
    running.clock.advance(10 * 60_000);
    await hook.catch(() => undefined);
  }
}

/**
 * Takes the harness buffers: counts `decision_result`s per request and the agent's
 * sockets, scans every line for the run's canaries, and drops it all.
 */
function drain(
  running: Scenario,
  canaries: readonly string[],
  state: { agentOpens: number; leaks: Leak[] },
  decisions: Map<string, number>,
): void {
  for (const received of running.phone.messages.splice(0)) {
    if (received.message.t !== 'decision_result') continue;
    const { requestId } = received.message;
    decisions.set(requestId, (decisions.get(requestId) ?? 0) + 1);
  }
  const relayLines = running.relay.takeLogs();
  for (const line of relayLines) {
    if (line.includes('"ws_open"') && line.includes(running.agentDeviceId)) state.agentOpens += 1;
  }
  const pushes = running.relay.push.received.splice(0);
  state.leaks.push(
    ...findLeaks(
      [
        { name: 'relay-log', lines: relayLines },
        { name: 'agent-log', lines: running.agent.takeLogs() },
        {
          name: 'push',
          lines: pushes.flatMap((push) => [
            Buffer.from(push.body).toString('latin1'),
            push.plaintext ?? '',
          ]),
        },
      ],
      canaries,
    ),
  );
}

async function reconnectPhone(running: Scenario): Promise<void> {
  const { phone, relay } = running;
  phone.disconnect();
  await eventually(
    () => relay.logs().some((line) => line.includes('"ws_close"') && line.includes(phone.deviceId)),
    'relay: phone still online',
  );
  await phone.connect();
  await phone.handshake(running.agentDeviceId, running.agentPublicKey);
}

/** After a drop, moves fake time on until the relay has the agent's next socket. */
async function awaitAgentBack(
  running: Scenario,
  before: number,
  state: { agentOpens: number; leaks: Leak[] },
  decisions: Map<string, number>,
  canaries: readonly string[],
): Promise<void> {
  for (let second = 0; second < 120 && state.agentOpens === before; second += 1) {
    running.clock.advance(1_000);
    await delay(20);
    drain(running, canaries, state, decisions);
  }
  if (state.agentOpens === before) throw new Error('soak: the agent did not reconnect in 120 s');
  // The phone's session with the agent is re-established on the agent's side.
  await reconnectPhone(running);
}

/** The interval between two requests, one fake second per `tickMs` of wall time. */
async function idle(running: Scenario, intervalMs: number, tickMs: number): Promise<void> {
  for (let elapsed = 0; elapsed < intervalMs; elapsed += 1_000) {
    running.clock.advance(Math.min(1_000, intervalMs - elapsed));
    await delay(tickMs);
  }
}

function every(period: number, round: number): boolean {
  return period > 0 && round % period === 0;
}

function percentiles(values: readonly number[]): SoakReport['latencyMs'] {
  if (values.length === 0) return { p50: 0, p99: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
  return { p50: Math.round(at(0.5)), p99: Math.round(at(0.99)), max: Math.round(sorted.at(-1)!) };
}
