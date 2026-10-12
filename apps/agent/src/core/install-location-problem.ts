/**
 * Why the running CLI file is not a stable place for a service to execute, or
 * `undefined` when it is (D22, 06 §5.4). launchd keeps the path forever, so it must
 * survive cache cleanups: the npx cache (`…/_npx/<hash>/…`), the pnpm dlx cache
 * (`…/dlx/…`) and anything under the temp directory are refused, and so is a source
 * file (`.ts`, run through a loader) that `node` cannot execute directly.
 */
export function installLocationProblem(scriptPath: string, tmpdir: string): string | undefined {
  const segments = scriptPath.split(/[\\/]/);
  if (segments.includes('_npx')) return 'it is running from the npx cache';
  if (segments.includes('dlx')) return 'it is running from the pnpm dlx cache';
  const temp = tmpdir.replace(/[\\/]+$/, '');
  if (temp !== '' && (scriptPath.startsWith(`${temp}/`) || scriptPath.startsWith(`${temp}\\`))) {
    return 'it is running from the temporary directory';
  }
  if (!/\.[cm]?js$/.test(scriptPath)) return 'it is not running from a built package';
  return undefined;
}
