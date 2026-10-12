import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** Absolute path of `bin/fake-claude.mjs`. */
export const FAKE_CLAUDE_BIN = fileURLToPath(new URL('../bin/fake-claude.mjs', import.meta.url));

/** Absolute path of `bin/record-hook.mjs`. */
export const RECORD_HOOK_BIN = fileURLToPath(new URL('../bin/record-hook.mjs', import.meta.url));

/**
 * Writes a `claude` launcher into `dir` (a POSIX script and a `claude.cmd` for Windows), so
 * code that spawns `claude` from `PATH` runs the fake. Returns the POSIX script path.
 */
export function writeClaudeShim(dir: string, nodePath: string = process.execPath): string {
  mkdirSync(dir, { recursive: true });
  const script = join(dir, 'claude');
  writeFileSync(script, `#!/bin/sh\nexec "${nodePath}" "${FAKE_CLAUDE_BIN}" "$@"\n`);
  chmodSync(script, 0o755);
  writeFileSync(join(dir, 'claude.cmd'), `@"${nodePath}" "${FAKE_CLAUDE_BIN}" %*\r\n`);
  return script;
}
