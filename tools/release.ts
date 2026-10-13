// Release tooling for the `remotectl` package (M1-09, ADR 0003).
//
//   tsx tools/release.ts version <x.y.z>          bump package.json + src/version.ts
//   tsx tools/release.ts verify <tag> [tarball]   pre-publish checks run by release.yml
//
// The pure functions are exported for tools/release.test.ts; the CLI at the bottom only
// does file I/O around them.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TAG_PREFIX = 'remotectl-v';
export const REPOSITORY_URL = 'git+https://github.com/IvanBBaev/remote-control.git';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERSION_LINE = /^export const AGENT_VERSION = '([^']*)';$/m;
// npm runs these on the user's machine at install time; the package must have none (06 §5.3).
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];

export interface AgentManifest {
  readonly name?: string;
  readonly version?: string;
  readonly private?: boolean;
  readonly files?: readonly string[];
  readonly bin?: Record<string, string>;
  readonly scripts?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly repository?: { readonly url?: string; readonly directory?: string };
  readonly publishConfig?: {
    readonly access?: string;
    readonly provenance?: boolean;
    readonly exports?: unknown;
  };
}

/** Parses `x.y.z` (no pre-release, no build metadata) or returns undefined. */
export function parseVersion(version: string): [number, number, number] | undefined {
  const match = SEMVER.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** True when `next` is a strictly higher `x.y.z` than `current`. */
export function isNewer(next: string, current: string): boolean {
  const a = parseVersion(next);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/** The git tag a version is released under. */
export function tagFor(version: string): string {
  return `${TAG_PREFIX}${version}`;
}

/** Rewrites the `AGENT_VERSION` constant; throws when the line is missing. */
export function rewriteVersionSource(source: string, version: string): string {
  if (!VERSION_LINE.test(source)) throw new Error('AGENT_VERSION line not found');
  return source.replace(VERSION_LINE, `export const AGENT_VERSION = '${version}';`);
}

/** Rewrites the top-level `"version"` of a package.json text, keeping its formatting. */
export function rewriteManifestVersion(text: string, version: string): string {
  const pattern = /^(\s{2}"version": )"[^"]*"/m;
  if (!pattern.test(text)) throw new Error('"version" field not found');
  return text.replace(pattern, `$1"${version}"`);
}

/** Problems that make the manifest unfit to publish under `tag`; empty when fine. */
export function manifestProblems(manifest: AgentManifest, tag: string): string[] {
  const problems: string[] = [];
  if (manifest.name !== 'remotectl')
    problems.push(`name is ${String(manifest.name)}, expected remotectl`);
  if (manifest.version === undefined || !parseVersion(manifest.version)) {
    problems.push(`version ${String(manifest.version)} is not x.y.z`);
  } else if (tag !== tagFor(manifest.version)) {
    problems.push(`tag ${tag} does not match ${tagFor(manifest.version)}`);
  }
  if (manifest.private === true) problems.push('package is private');
  if (JSON.stringify(manifest.files) !== JSON.stringify(['dist']))
    problems.push('files must be exactly ["dist"]');
  if (manifest.bin?.remotectl !== 'dist/cli.mjs')
    problems.push('bin.remotectl must be dist/cli.mjs');
  for (const script of INSTALL_SCRIPTS) {
    if (manifest.scripts?.[script] !== undefined) problems.push(`has a ${script} script`);
  }
  // tsdown bundles everything; a runtime dependency would make `npx` install a tree (06 §5.3).
  if (Object.keys(manifest.dependencies ?? {}).length > 0)
    problems.push('has runtime dependencies');
  if (manifest.repository?.url !== REPOSITORY_URL)
    problems.push(`repository.url must be ${REPOSITORY_URL}`);
  if (manifest.repository?.directory !== 'apps/agent')
    problems.push('repository.directory must be apps/agent');
  if (manifest.publishConfig?.access !== 'public')
    problems.push('publishConfig.access must be public');
  if (manifest.publishConfig?.provenance !== true)
    problems.push('publishConfig.provenance must be true');
  return problems;
}

/** Problems with the packed tarball's file list (entries as `tar -t` prints them). */
export function tarballProblems(entries: readonly string[]): string[] {
  const problems: string[] = [];
  const files = entries.filter((entry) => !entry.endsWith('/'));
  for (const file of files) {
    const allowed =
      file === 'package/package.json' ||
      /^package\/(README|LICENSE)(\.md)?$/i.test(file) ||
      /^package\/dist\/[^/]+\.(mjs|cjs|js|map)$/.test(file);
    if (!allowed) problems.push(`unexpected file ${file}`);
  }
  for (const required of [
    'package/package.json',
    'package/dist/cli.mjs',
    'package/dist/hook.cjs',
  ]) {
    if (!files.includes(required)) problems.push(`missing ${required}`);
  }
  return problems;
}

/** Problems with the manifest as packed (pnpm rewrites `workspace:` and `publishConfig`). */
export function packedManifestProblems(manifest: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (JSON.stringify(manifest).includes('workspace:'))
    problems.push('packed manifest still has workspace: ranges');
  const exportsField = JSON.stringify(manifest.exports ?? null);
  if (exportsField.includes('src/')) problems.push('packed exports point into src/');
  return problems;
}

// CLI wrapper; the logic above is unit-tested.
function main(argv: readonly string[]): number {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const manifestPath = `${root}apps/agent/package.json`;
  const versionPath = `${root}apps/agent/src/version.ts`;
  const [command, arg, tarball] = argv;

  if (command === 'version' && arg !== undefined) {
    const text = readFileSync(manifestPath, 'utf8');
    const current = (JSON.parse(text) as AgentManifest).version ?? '0.0.0';
    if (!isNewer(arg, current)) {
      console.error(`version ${arg} must be x.y.z and higher than ${current}`);
      return 1;
    }
    writeFileSync(manifestPath, rewriteManifestVersion(text, arg));
    writeFileSync(versionPath, rewriteVersionSource(readFileSync(versionPath, 'utf8'), arg));
    console.log(`remotectl ${current} -> ${arg}; commit, then tag ${tagFor(arg)}`);
    return 0;
  }

  if (command === 'verify' && arg !== undefined) {
    const problems = manifestProblems(
      JSON.parse(readFileSync(manifestPath, 'utf8')) as AgentManifest,
      arg,
    );
    if (tarball !== undefined) {
      const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
      problems.push(...tarballProblems(entries));
      const packed = execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], {
        encoding: 'utf8',
      });
      problems.push(...packedManifestProblems(JSON.parse(packed) as Record<string, unknown>));
    }
    for (const problem of problems) console.error(`release check: ${problem}`);
    if (problems.length === 0) console.log(`release check: ${arg} ok`);
    return problems.length === 0 ? 0 : 1;
  }

  console.error('usage: release.ts version <x.y.z> | verify <tag> [tarball]');
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
