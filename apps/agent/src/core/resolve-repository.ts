import type { PathPort } from '../ports/path-port.js';

export type RepositoryRefusal = 'invalid_path' | 'not_absolute' | 'not_found' | 'not_allowed';

export type ResolveRepositoryResult =
  | {
      readonly allowed: true;
      /** The allow-list entry as written in the config file. */
      readonly root: string;
      /** The canonical path of the candidate. */
      readonly realPath: string;
    }
  | { readonly allowed: false; readonly reason: RepositoryRefusal };

/**
 * The allow-list check (02 §4.1, D13): `candidate` is allowed only when its `realpath`
 * equals or lies inside the `realpath` of an allow-listed root. Both sides are resolved
 * at check time, so a symlink or a `..` cannot lead outside the list, and a root that
 * moved or was replaced by a symlink is judged by where it points now. Paths with
 * whitespace at either end are refused outright instead of being trimmed.
 */
export async function resolveRepository(
  roots: readonly string[],
  candidate: string,
  paths: PathPort,
): Promise<ResolveRepositoryResult> {
  if (candidate.length === 0 || candidate.trim() !== candidate || candidate.includes('\0')) {
    return { allowed: false, reason: 'invalid_path' };
  }
  if (!paths.isAbsolute(candidate)) return { allowed: false, reason: 'not_absolute' };
  const realPath = await paths.realpath(candidate);
  if (realPath === undefined) return { allowed: false, reason: 'not_found' };
  for (const root of roots) {
    if (!paths.isAbsolute(root)) continue;
    const realRoot = await paths.realpath(root);
    if (realRoot !== undefined && paths.contains(realRoot, realPath)) {
      return { allowed: true, root, realPath };
    }
  }
  return { allowed: false, reason: 'not_allowed' };
}
