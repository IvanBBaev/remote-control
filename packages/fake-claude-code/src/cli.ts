import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Clock, Random } from '@remote-control/protocol';

import { isHookEventName } from './events.js';
import { HookRunner, type HookInput } from './hook-runner.js';
import type { Env } from './paths.js';
import { DOCUMENTED_EXAMPLES } from './payloads.js';
import { findAgentEntry, isWorkspaceTrusted, listAgents } from './roster.js';
import { resolveScenario, withPrompt } from './scenarios.js';
import { FakeSession } from './session.js';
import { loadHooks } from './settings.js';

/** Default `--version`; override with `FAKE_CLAUDE_VERSION` to test version gates. */
export const DEFAULT_VERSION = '2.1.300';

/** 04 §2.8: `--resume <uuid> --bg` keeps the session ID from this version on. */
export const RESUME_SAME_ID_VERSION = '2.1.257';

export interface CliIo {
  readonly env: Env;
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly clock: Clock;
  readonly random: Random;
  readonly pid: number;
}

/** Compares dotted numeric versions; `-1`, `0` or `1`. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

interface ParsedArgs {
  readonly positionals: string[];
  readonly flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set([
  '--name',
  '--resume',
  '--cwd',
  '--input',
  '--fixture',
  '--permission-mode',
  '--scenario',
]);

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      flags.set(arg, value);
      index += 1;
    } else if (arg.startsWith('-')) {
      flags.set(arg, true);
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

class UsageError extends Error {}

function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

/**
 * The `claude` CLI surface the agent uses (04 §2.8, §5.4), plus two test-only commands:
 * `fire <Event>` (one hook event) and `scenario <name|file>` (a foreground session).
 * Returns the exit code.
 */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    return await dispatch(parseArgs(argv), io);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

async function dispatch(args: ParsedArgs, io: CliIo): Promise<number> {
  const version = io.env.FAKE_CLAUDE_VERSION ?? DEFAULT_VERSION;
  if (args.flags.has('--version') || args.flags.has('-v')) {
    io.stdout(`${version} (Claude Code)\n`);
    return 0;
  }
  const [command, ...rest] = args.positionals;
  if (command === 'agents') return agents(args, io);
  if (command === 'fire') return fire(rest[0], args, io);
  if (command === 'scenario') {
    if (rest[0] === undefined) throw new UsageError('scenario needs a name or a file');
    return runSession(io, args, { scenario: rest[0], kind: 'interactive', prompt: rest[1] });
  }
  if (args.flags.has('--bg')) return background(args, io, version);
  throw new UsageError(
    'usage: fake-claude --version | agents --json [--all] [--cwd <dir>] | --bg [--name <n>] "<prompt>" | --resume <uuid> --bg "<prompt>" | fire <Event> --input <file>|--fixture <name> | scenario <name|file>',
  );
}

function agents(args: ParsedArgs, io: CliIo): number {
  if (!args.flags.has('--json')) throw new UsageError('only `agents --json` is supported');
  const cwd = stringFlag(args, '--cwd');
  const rows = listAgents(io.env, {
    all: args.flags.has('--all'),
    ...(cwd !== undefined ? { cwd: resolve(io.cwd, cwd) } : {}),
  });
  io.stdout(`${JSON.stringify(rows, null, 2)}\n`);
  return 0;
}

/**
 * `--bg` and `--resume <uuid> --bg` (04 §2.8). Assumption: the fake runs the session
 * inline and exits when it ends, instead of handing it to a supervisor process; the
 * roster entry and hooks look the same to the agent.
 */
async function background(args: ParsedArgs, io: CliIo, version: string): Promise<number> {
  if (args.flags.has('-p') || args.flags.has('--print')) {
    throw new UsageError('--bg cannot be used with -p');
  }
  if (!isWorkspaceTrusted(io.env, io.cwd)) {
    io.stderr('Workspace not trusted\n');
    return 1;
  }
  const resumeId = stringFlag(args, '--resume');
  const prompt = args.positionals[0];
  const scenario = stringFlag(args, '--scenario') ?? io.env.FAKE_CLAUDE_SCENARIO ?? 'tools';
  if (resumeId === undefined) {
    return runSession(io, args, { scenario, kind: 'background', prompt, announce: true });
  }
  const previous = findAgentEntry(io.env, resumeId);
  if (previous === undefined) {
    io.stderr(`No conversation found with session ID: ${resumeId}\n`);
    return 1;
  }
  // Before 2.1.257 `--resume --bg` silently forked into a new session ID (04 §2.8).
  const sameId = compareVersions(version, RESUME_SAME_ID_VERSION) >= 0;
  return runSession(io, args, {
    scenario,
    kind: 'background',
    prompt,
    announce: true,
    source: 'resume',
    ...(sameId ? { sessionId: resumeId } : {}),
    ...(previous.name !== undefined ? { name: previous.name } : {}),
  });
}

async function runSession(
  io: CliIo,
  args: ParsedArgs,
  options: {
    scenario: string;
    kind: 'interactive' | 'background';
    prompt?: string | undefined;
    announce?: boolean;
    source?: 'startup' | 'resume';
    sessionId?: string;
    name?: string;
  },
): Promise<number> {
  const name = stringFlag(args, '--name') ?? options.name;
  const permissionMode = stringFlag(args, '--permission-mode');
  const session = new FakeSession({
    env: io.env,
    cwd: io.cwd,
    clock: io.clock,
    random: io.random,
    scenario: withPrompt(resolveScenario(options.scenario), options.prompt),
    kind: options.kind,
    pid: io.pid,
    ...(options.source !== undefined ? { source: options.source } : {}),
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
  });
  // Assumption: the real CLI's start message is not documented; the agent reads the UUID
  // from `agents --json` or `SessionStart`, never from this line.
  if (options.announce === true) io.stdout(`Started background session ${session.sessionId}\n`);
  const result = await session.run();
  for (const warning of result.warnings) io.stderr(`warning: ${warning}\n`);
  if (options.announce !== true) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

/** `fire <Event>`: one event against the configured hooks; exit 0 allow, 2 deny/block, 1 none. */
async function fire(event: string | undefined, args: ParsedArgs, io: CliIo): Promise<number> {
  if (event === undefined || !isHookEventName(event)) {
    throw new UsageError(`fire needs a hook event name, got ${String(event)}`);
  }
  const inputFile = stringFlag(args, '--input');
  const fixture = stringFlag(args, '--fixture');
  let input: HookInput;
  if (inputFile !== undefined) {
    input = JSON.parse(readFileSync(resolve(io.cwd, inputFile), 'utf8')) as HookInput;
  } else if (fixture !== undefined && DOCUMENTED_EXAMPLES[fixture] !== undefined) {
    input = DOCUMENTED_EXAMPLES[fixture];
  } else {
    throw new UsageError('fire needs --input <file> or --fixture <documented example>');
  }
  const settings = loadHooks({ env: io.env, cwd: io.cwd });
  const runner = new HookRunner({ settings, cwd: io.cwd, env: io.env, clock: io.clock });
  const result = await runner.fire(event, { ...input, hook_event_name: event });
  await runner.drain();
  io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  if (result.decision === 'allow') return 0;
  return result.decision === 'deny' || result.decision === 'block' ? 2 : 1;
}
