import type { PathPort } from '../ports/path-port.js';
import { AgentConfig } from './agent-config.js';

export type ParseConfigResult =
  | { readonly ok: true; readonly config: AgentConfig }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Parses and validates the config file text. Errors name the offending field so the
 * user can fix the file; an invalid config is fatal for `run` (D22).
 */
export function parseConfig(text: string, paths: PathPort): ParseConfigResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`not valid JSON: ${(error as Error).message}`] };
  }
  const parsed = AgentConfig.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => {
        const where = issue.path.length === 0 ? '(root)' : issue.path.join('.');
        return `${where}: ${issue.message}`;
      }),
    };
  }
  const errors = parsed.data.repositories.flatMap((root, index) =>
    paths.isAbsolute(root) ? [] : [`repositories.${index}: must be an absolute path`],
  );
  return errors.length > 0 ? { ok: false, errors } : { ok: true, config: parsed.data };
}
