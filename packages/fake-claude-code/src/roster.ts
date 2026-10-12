import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import { type Env, configDir, globalConfigPath } from './paths.js';

/** `claude agents --json` row, field for field from 04 §2.8. */
export interface AgentEntry {
  readonly cwd: string;
  readonly kind: 'interactive' | 'background';
  /** ISO 8601. */
  readonly startedAt: string;
  readonly id: string;
  readonly state: 'working' | 'blocked' | 'done' | 'failed' | 'stopped';
  readonly pid: number;
  readonly status: 'busy' | 'waiting' | 'idle';
  readonly waitingFor?:
    'permission prompt' | 'input needed' | 'sandbox request' | 'worker request' | 'dialog open';
  readonly sessionId: string;
  readonly name?: string;
}

/**
 * Session roster under `<config>/jobs/` (04 §2.8 calls the real one "not a stable
 * interface"; the fake's file layout is its own). One JSON file per session.
 */
function jobsDir(env: Env): string {
  return join(configDir(env), 'jobs');
}

export function writeAgentEntry(env: Env, entry: AgentEntry): void {
  const dir = jobsDir(env);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${entry.sessionId}.json`);
  // Temp file + rename, so a concurrent `agents --json` never reads half a file.
  writeFileSync(`${file}.tmp`, JSON.stringify(entry, null, 2));
  renameSync(`${file}.tmp`, file);
}

export function readAgentEntries(env: Env): AgentEntry[] {
  let files: string[];
  try {
    files = readdirSync(jobsDir(env));
  } catch {
    return [];
  }
  return files
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(join(jobsDir(env), file), 'utf8')) as AgentEntry)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function findAgentEntry(env: Env, sessionId: string): AgentEntry | undefined {
  return readAgentEntries(env).find((entry) => entry.sessionId === sessionId);
}

/**
 * `claude agents --json [--all] [--cwd <dir>]` (04 §2.8). Assumption: without `--all` only
 * live sessions (`working` / `blocked`) are listed; the output is a JSON array.
 */
export function listAgents(env: Env, options: { all: boolean; cwd?: string }): AgentEntry[] {
  return readAgentEntries(env).filter(
    (entry) =>
      (options.all || entry.state === 'working' || entry.state === 'blocked') &&
      (options.cwd === undefined || resolve(entry.cwd) === resolve(options.cwd)),
  );
}

function readGlobalConfig(env: Env): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(globalConfigPath(env), 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Workspace trust (04 §2.1: a folder or one of its parents). Assumption: stored as
 * `projects[<path>].hasTrustDialogAccepted` in the global config file, as in current
 * Claude Code builds.
 */
export function isWorkspaceTrusted(env: Env, cwd: string): boolean {
  const projects = readGlobalConfig(env).projects;
  if (typeof projects !== 'object' || projects === null) return false;
  const trusted = Object.entries(projects as Record<string, unknown>)
    .filter(
      ([, value]) =>
        (value as { hasTrustDialogAccepted?: unknown } | null)?.hasTrustDialogAccepted === true,
    )
    .map(([path]) => resolve(path));
  const target = resolve(cwd);
  return trusted.some(
    (path) => target === path || target.startsWith(path.endsWith(sep) ? path : path + sep),
  );
}

/** Test helper: marks `dir` as trusted, the way accepting the trust dialog would. */
export function trustWorkspace(env: Env, dir: string): void {
  const config = readGlobalConfig(env);
  const projects = (config.projects ?? {}) as Record<string, unknown>;
  projects[resolve(dir)] = { hasTrustDialogAccepted: true };
  const file = globalConfigPath(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...config, projects }, null, 2));
}
