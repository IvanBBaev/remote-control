// Real-CLI verification kit for the Claude Code hooks (M0-23, 04 W5/W12). Not CI.
//
//   pnpm build                                   builds apps/agent/dist/hook.cjs first
//   tsx tools/verify-claude-code.ts overhead [--runs 200]
//   tsx tools/verify-claude-code.ts hold [--hold-seconds 660] [--decision allow|deny]
//
// Both commands run the shipped `hook.cjs` from a throwaway data directory with its own
// `agent.json`, against a loopback receiver in this process: the installed `remotectl`,
// its hooks and its settings are never touched. Results go to
// docs/verification/claude-code-hooks.md. The pure functions are exported for
// tools/verify-claude-code.test.ts; the CLI at the bottom does the I/O.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

/** The A2 check: a hold beyond Claude Code's 600 s default command-hook timeout. */
export const DEFAULT_HOLD_SECONDS = 660;
/** The installed `timeout` of the blocking hook in the hold run (D10's 30 min ceiling). */
export const HOLD_HOOK_TIMEOUT_SECONDS = 1800;
/** 04 W12: a 200-tool-call run. */
export const DEFAULT_RUNS = 200;
/** 04 W12 target for the hook's p95 overhead. */
export const OVERHEAD_TARGET_MS = 150;
/** The file the forced `Bash` permission creates when it is allowed. */
export const MARKER_FILE = 'rc-verified.txt';
export const HOLD_PROMPT = `Run exactly this shell command and nothing else: touch ${MARKER_FILE}`;

export type Decision = 'allow' | 'deny';

export type Options =
  | { readonly command: 'overhead'; readonly runs: number }
  | { readonly command: 'hold'; readonly holdSeconds: number; readonly decision: Decision };

function positiveInteger(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) return undefined;
  return Number(raw);
}

/** Parses the CLI arguments; `undefined` on anything unknown or malformed. */
export function parseOptions(argv: readonly string[]): Options | undefined {
  const [command, ...rest] = argv;
  const flags = new Map<string, string | undefined>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!;
    if (!flag.startsWith('--') || flags.has(flag)) return undefined;
    flags.set(flag, rest[i + 1]);
  }
  if (command === 'overhead') {
    const runs = flags.has('--runs') ? positiveInteger(flags.get('--runs')) : DEFAULT_RUNS;
    const known = [...flags.keys()].every((flag) => flag === '--runs');
    return runs === undefined || !known ? undefined : { command, runs };
  }
  if (command === 'hold') {
    const holdSeconds = flags.has('--hold-seconds')
      ? positiveInteger(flags.get('--hold-seconds'))
      : DEFAULT_HOLD_SECONDS;
    const decision = flags.get('--decision') ?? 'allow';
    const known = [...flags.keys()].every((flag) =>
      ['--hold-seconds', '--decision'].includes(flag),
    );
    if (holdSeconds === undefined || !known) return undefined;
    if (decision !== 'allow' && decision !== 'deny') return undefined;
    return { command, holdSeconds, decision };
  }
  return undefined;
}

/** Nearest-rank percentile of `values` (milliseconds); 0 for no values. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export interface Timings {
  readonly runs: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

export function timings(values: readonly number[]): Timings {
  return {
    runs: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: values.length === 0 ? 0 : Math.max(...values),
  };
}

const ms = (value: number): string => `${value.toFixed(1)} ms`;

/** The overhead report: the hook against a bare Node start, judged on the hook's p95. */
export function overheadReport(hook: Timings, node: Timings): string {
  const verdict = hook.p95 < OVERHEAD_TARGET_MS ? 'PASS' : 'FAIL';
  return [
    `| Measured | Runs | p50 | p95 | max |`,
    `| --- | --- | --- | --- | --- |`,
    `| \`node -e ""\` (Node start) | ${node.runs} | ${ms(node.p50)} | ${ms(node.p95)} | ${ms(node.max)} |`,
    `| \`hook.cjs\` PostToolUse round trip | ${hook.runs} | ${ms(hook.p50)} | ${ms(hook.p95)} | ${ms(hook.max)} |`,
    '',
    `hook p95 ${ms(hook.p95)} vs target < ${OVERHEAD_TARGET_MS} ms: ${verdict}`,
  ].join('\n');
}

/** `"<node>" "<script>" <T>`, the command shape `remotectl hooks install` writes. */
export function hookCommand(execPath: string, scriptPath: string, timeout: number): string {
  return `"${execPath}" "${scriptPath}" ${timeout}`;
}

/** The temp repo's `.claude/settings.json`: the blocking hook with a 30 min timeout only. */
export function holdSettings(command: string): Record<string, unknown> {
  return {
    hooks: {
      PermissionRequest: [
        { hooks: [{ type: 'command', command, timeout: HOLD_HOOK_TIMEOUT_SECONDS }] },
      ],
    },
  };
}

/**
 * The command the owner runs in the temp repo. `--setting-sources project,local` leaves
 * out `~/.claude/settings.json`, so an installed remotectl's hooks do not answer first.
 */
export function claudeCommand(repo: string, background = false): string {
  const bg = background ? ' --bg' : '';
  return `cd '${repo}' && claude${bg} --setting-sources project,local ${JSON.stringify(HOLD_PROMPT)}`;
}

/** The hook answer for the decision (same shape as the adapter's, 04 §2.2). */
export function permissionAnswer(decision: Decision): Record<string, unknown> {
  const verdict =
    decision === 'allow'
      ? { behavior: 'allow' }
      : { behavior: 'deny', message: 'Denied by the M0-23 verification kit', interrupt: false };
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: verdict } };
}

/** A PostToolUse input as Claude Code sends it, for the overhead run. */
export function postToolUseInput(index: number): string {
  return JSON.stringify({
    hook_event_name: 'PostToolUse',
    session_id: 'm0-23-overhead',
    cwd: tmpdir(),
    tool_name: 'Bash',
    tool_input: { command: `echo ${index}` },
    tool_response: { stdout: `${index}\n`, stderr: '', interrupted: false },
  });
}

// ---------------------------------------------------------------------------- I/O

/** A throwaway bearer token for the loopback receiver (WebCrypto, D3). */
function newToken(): string {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll('-', '');
}

const root = fileURLToPath(new URL('..', import.meta.url));
const HOOK_SCRIPT = join(root, 'apps/agent/dist/hook.cjs');

interface Receiver {
  readonly server: Server;
  readonly port: number;
}

type Route = (input: Record<string, unknown>, req: IncomingMessage) => Promise<unknown>;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** A loopback stand-in for the agent's receiver: bearer check, then `route`. */
async function startReceiver(token: string, route: Route): Promise<Receiver> {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    void readBody(req)
      .then((text) => route(JSON.parse(text) as Record<string, unknown>, req))
      .then((answer) => {
        if (res.destroyed) return;
        if (answer === undefined) res.writeHead(204).end();
        else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
      })
      .catch(() => res.writeHead(400).end());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

/** A data directory with its own `hook.cjs` + `agent.json`, as `hooks install` lays out. */
async function dataDir(port: number, token: string): Promise<string> {
  if (!existsSync(HOOK_SCRIPT)) throw new Error(`${HOOK_SCRIPT} is missing: run pnpm build`);
  const dir = await mkdtemp(join(tmpdir(), 'rc-m0-23-data-'));
  await copyFile(HOOK_SCRIPT, join(dir, 'hook.cjs'));
  await writeFile(join(dir, 'agent.json'), JSON.stringify({ port, token }), { mode: 0o600 });
  return join(dir, 'hook.cjs');
}

function timeRun(command: string, args: readonly string[], input: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('close', () => resolve(performance.now() - started));
    child.stdin.end(input);
  });
}

function claudeVersion(): string {
  try {
    return execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return 'not found on PATH';
  }
}

async function overhead(runs: number): Promise<number> {
  const token = newToken();
  const receiver = await startReceiver(token, () => Promise.resolve(undefined));
  const script = await dataDir(receiver.port, token);
  const node: number[] = [];
  const hook: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    node.push(await timeRun(process.execPath, ['-e', ''], ''));
    hook.push(await timeRun(process.execPath, [script, '5'], postToolUseInput(i)));
  }
  receiver.server.close();
  console.log(
    `Node ${process.version}, ${process.platform}/${process.arch}, claude: ${claudeVersion()}\n`,
  );
  console.log(overheadReport(timings(hook), timings(node)));
  return timings(hook).p95 < OVERHEAD_TARGET_MS ? 0 : 1;
}

const stamp = (started: number): string =>
  `[+${((performance.now() - started) / 1000).toFixed(1)} s]`;

async function hold(holdSeconds: number, decision: Decision): Promise<number> {
  const started = performance.now();
  const token = newToken();
  const repo = await mkdtemp(join(tmpdir(), 'rc-m0-23-repo-'));
  const receiver = await startReceiver(token, async (input, req) => {
    const event = String(input['hook_event_name']);
    const tool = typeof input['tool_name'] === 'string' ? input['tool_name'] : '';
    console.log(`${stamp(started)} ${event} ${tool} arrived; holding ${holdSeconds} s`);
    const arrived = performance.now();
    let gone = false;
    req.socket.on('close', () => {
      if (gone) return;
      gone = true;
      const held = ((performance.now() - arrived) / 1000).toFixed(1);
      console.log(`${stamp(started)} hook disconnected after ${held} s (Ctrl+C, Esc or a timeout)`);
    });
    await new Promise((resolve) => setTimeout(resolve, holdSeconds * 1000));
    if (gone) return undefined;
    console.log(
      `${stamp(started)} answered ${decision} after ${((performance.now() - arrived) / 1000).toFixed(1)} s`,
    );
    gone = true;
    setTimeout(() => {
      const created = existsSync(join(repo, MARKER_FILE));
      console.log(
        `${stamp(started)} ${MARKER_FILE} ${created ? 'exists' : 'does not exist'} 30 s later`,
      );
    }, 30_000);
    return permissionAnswer(decision);
  });
  const script = await dataDir(receiver.port, token);
  execFileSync('git', ['init', '-q', repo]);
  await mkdir(join(repo, '.claude'));
  const command = hookCommand(process.execPath, script, HOLD_HOOK_TIMEOUT_SECONDS);
  await writeFile(
    join(repo, '.claude', 'settings.json'),
    `${JSON.stringify(holdSettings(command), null, 2)}\n`,
  );
  console.log(
    [
      `claude: ${claudeVersion()}`,
      `Temp repo: ${repo}`,
      `Receiver: 127.0.0.1:${receiver.port}; the hook is held ${holdSeconds} s, then answered "${decision}".`,
      '',
      'In another terminal (trust the folder when asked; --setting-sources keeps the hooks of',
      'an installed remotectl in ~/.claude/settings.json out of the run):',
      '',
      `  ${claudeCommand(repo)}`,
      '',
      'Background variant (04 W5), polled with `claude agents --json --all`:',
      '',
      `  ${claudeCommand(repo, true)}`,
      '',
      'Watch the terminal while the hook is held (A3). Repeat with Ctrl+C during the hold to',
      'record what Ctrl+C does. Stop this process with Ctrl+C when done.',
      '',
    ].join('\n'),
  );
  return new Promise<number>(() => undefined);
}

export async function main(argv: readonly string[]): Promise<number> {
  const options = parseOptions(argv);
  if (options === undefined) {
    console.error(
      'usage: verify-claude-code.ts overhead [--runs N] | hold [--hold-seconds N] [--decision allow|deny]',
    );
    return 2;
  }
  return options.command === 'overhead'
    ? overhead(options.runs)
    : hold(options.holdSeconds, options.decision);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
