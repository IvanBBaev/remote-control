import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { anonymisePayload, keySetsByEvent } from './anonymise.js';

export interface AnonymiseDirectoryOptions {
  /** Raw recordings from `bin/record-hook.mjs` (never committed). */
  readonly rawDir: string;
  /** Anonymised fixtures plus `key-sets.json` (committed). */
  readonly outDir: string;
  readonly claudeCodeVersion: string;
}

export interface AnonymiseDirectoryResult {
  readonly written: readonly string[];
  readonly keySets: Record<string, string[][]>;
}

/**
 * `fixtures:anonymise` (07 §5.4): anonymises every `*.json` recording in `rawDir` into
 * `outDir` and writes the per-event key-set snapshot. Nothing is written unless every
 * file passes; `captured_at` comes from each recording's modification time.
 */
export function anonymiseDirectory(options: AnonymiseDirectoryOptions): AnonymiseDirectoryResult {
  const files = readdirSync(options.rawDir)
    .filter((file) => file.endsWith('.json'))
    .sort();
  const anonymised = files.map((file) => {
    const path = join(options.rawDir, file);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    try {
      return {
        file,
        payload: anonymisePayload(raw, {
          claudeCodeVersion: options.claudeCodeVersion,
          capturedAt: statSync(path).mtime.toISOString(),
        }),
      };
    } catch (error) {
      throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  });
  mkdirSync(options.outDir, { recursive: true });
  const written = anonymised.map(({ file, payload }) => {
    const target = join(options.outDir, basename(file));
    writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);
    return target;
  });
  const keySets = keySetsByEvent(anonymised.map(({ payload }) => payload));
  writeFileSync(join(options.outDir, 'key-sets.json'), `${JSON.stringify(keySets, null, 2)}\n`);
  return { written, keySets };
}

/** `fixtures:anonymise <rawDir> <outDir> --claude-version <x.y.z>`; returns the exit code. */
export function anonymiseMain(
  argv: readonly string[],
  io: { stdout: (text: string) => void; stderr: (text: string) => void },
): number {
  const positionals = argv.filter(
    (arg, index) => !arg.startsWith('--') && argv[index - 1] !== '--claude-version',
  );
  const versionIndex = argv.indexOf('--claude-version');
  const version = versionIndex >= 0 ? argv[versionIndex + 1] : undefined;
  const [rawDir, outDir] = positionals;
  if (rawDir === undefined || outDir === undefined || version === undefined) {
    io.stderr('usage: fixtures:anonymise <rawDir> <outDir> --claude-version <x.y.z>\n');
    return 2;
  }
  try {
    const result = anonymiseDirectory({ rawDir, outDir, claudeCodeVersion: version });
    io.stdout(`anonymised ${String(result.written.length)} payload(s) into ${outDir}\n`);
    return 0;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
