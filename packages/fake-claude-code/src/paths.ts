import { homedir } from 'node:os';
import { join } from 'node:path';

export type Env = Readonly<Record<string, string | undefined>>;

/** The user's home directory as the fake sees it: `$HOME`, then `%USERPROFILE%`. */
export function homeDir(env: Env): string {
  return env.HOME ?? env.USERPROFILE ?? homedir();
}

/** `~/.claude`, or `$CLAUDE_CONFIG_DIR` when set (04 §2.6, D11). */
export function configDir(env: Env): string {
  return env.CLAUDE_CONFIG_DIR ?? join(homeDir(env), '.claude');
}

/**
 * Global state file holding workspace trust. Assumption: `~/.claude.json`, or
 * `$CLAUDE_CONFIG_DIR/.claude.json` when the config dir is moved (04 §2 is silent).
 */
export function globalConfigPath(env: Env): string {
  return env.CLAUDE_CONFIG_DIR === undefined
    ? join(homeDir(env), '.claude.json')
    : join(env.CLAUDE_CONFIG_DIR, '.claude.json');
}

/**
 * Project folder name under `projects/` (04 §2.6): the cwd with every non-alphanumeric
 * character replaced by `-`; names over 200 characters are truncated and suffixed with a
 * hash. Assumption: the hash is not specified; the fake uses an 8-hex-digit FNV-1a.
 */
export function projectDirName(cwd: string): string {
  const name = cwd.replace(/[^A-Za-z0-9]/g, '-');
  if (name.length <= 200) return name;
  let hash = 0x811c9dc5;
  for (const char of cwd) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${name.slice(0, 200)}-${hash.toString(16).padStart(8, '0')}`;
}

/** `<config>/projects/<project>/<session-id>.jsonl` (04 §2.6). */
export function transcriptPath(env: Env, cwd: string, sessionId: string): string {
  return join(configDir(env), 'projects', projectDirName(cwd), `${sessionId}.jsonl`);
}
