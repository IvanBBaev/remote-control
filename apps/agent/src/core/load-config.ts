import type { FileSystem } from '../ports/file-system.js';
import type { PathPort } from '../ports/path-port.js';
import type { AgentConfig } from './agent-config.js';
import { parseConfig } from './parse-config.js';

export const CONFIG_FILE = 'config.json';

export type LoadConfigResult =
  | { readonly status: 'ok'; readonly path: string; readonly config: AgentConfig }
  | { readonly status: 'missing'; readonly path: string }
  | { readonly status: 'invalid'; readonly path: string; readonly errors: readonly string[] };

/** Reads `config.json` from the env-paths config dir and validates it. */
export async function loadConfig(
  configDir: string,
  fs: FileSystem,
  paths: PathPort,
): Promise<LoadConfigResult> {
  const path = paths.join(configDir, CONFIG_FILE);
  const text = await fs.readText(path);
  if (text === undefined) return { status: 'missing', path };
  const parsed = parseConfig(text, paths);
  return parsed.ok
    ? { status: 'ok', path, config: parsed.config }
    : { status: 'invalid', path, errors: parsed.errors };
}
