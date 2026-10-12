import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { nodePaths } from '../adapters/node-file-system.js';
import { resolveRepository } from './resolve-repository.js';

/**
 * Allow-list fixtures on a real temp file system (02 W12): symlinks into and out of a
 * root, `..` traversal, trailing whitespace, sibling-prefix names, missing paths.
 */
describe('resolveRepository', () => {
  let base: string;
  let repo: string;
  let outside: string;

  beforeAll(async () => {
    // realpath: on macOS the temp dir itself sits behind the /var → /private/var symlink.
    base = await realpath(await mkdtemp(join(tmpdir(), 'remotectl-allow-')));
    repo = join(base, 'repo');
    outside = join(base, 'outside');
    await mkdir(join(repo, 'src', 'deep'), { recursive: true });
    await mkdir(outside);
    await mkdir(join(base, 'repo-evil'));
    await mkdir(join(base, 'repo '));
    await mkdir(join(repo, '..hidden'));
    await writeFile(join(repo, 'file.txt'), 'x');
    await symlink(outside, join(repo, 'escape'));
    await symlink(join(repo, 'src'), join(base, 'link-into-repo'));
    await symlink(repo, join(base, 'root-link'));
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('allows the root itself and paths inside it', async () => {
    expect(await resolveRepository([repo], repo, nodePaths)).toEqual({
      allowed: true,
      root: repo,
      realPath: repo,
    });
    expect(await resolveRepository([repo], join(repo, 'src', 'deep'), nodePaths)).toMatchObject({
      allowed: true,
      realPath: join(repo, 'src', 'deep'),
    });
    expect(await resolveRepository([repo], join(repo, '..hidden'), nodePaths)).toMatchObject({
      allowed: true,
    });
  });

  it('refuses a symlink inside the root that points outside it', async () => {
    expect(await resolveRepository([repo], join(repo, 'escape'), nodePaths)).toEqual({
      allowed: false,
      reason: 'not_allowed',
    });
  });

  it('allows a symlink outside the root that points into it, by its real path', async () => {
    expect(await resolveRepository([repo], join(base, 'link-into-repo'), nodePaths)).toEqual({
      allowed: true,
      root: repo,
      realPath: join(repo, 'src'),
    });
  });

  it('resolves a symlinked allow-list root to where it points', async () => {
    const root = join(base, 'root-link');
    expect(await resolveRepository([root], join(repo, 'src'), nodePaths)).toMatchObject({
      allowed: true,
      root,
    });
  });

  it('refuses `..` traversal out of the root', async () => {
    expect(await resolveRepository([repo], `${repo}/../outside`, nodePaths)).toEqual({
      allowed: false,
      reason: 'not_allowed',
    });
    expect(await resolveRepository([repo], `${repo}/src/../..`, nodePaths)).toEqual({
      allowed: false,
      reason: 'not_allowed',
    });
    expect(await resolveRepository([repo], `${repo}/src/..`, nodePaths)).toMatchObject({
      allowed: true,
      realPath: repo,
    });
  });

  it('refuses a sibling whose name only starts with the root name', async () => {
    expect(await resolveRepository([repo], join(base, 'repo-evil'), nodePaths)).toEqual({
      allowed: false,
      reason: 'not_allowed',
    });
  });

  it('refuses a trailing or leading space instead of trimming it', async () => {
    expect(await resolveRepository([repo], `${repo} `, nodePaths)).toEqual({
      allowed: false,
      reason: 'invalid_path',
    });
    expect(await resolveRepository([repo], ` ${repo}`, nodePaths)).toEqual({
      allowed: false,
      reason: 'invalid_path',
    });
    // An allow-listed `repo` does not cover the distinct directory `repo `.
    expect(await resolveRepository([`${repo} `], repo, nodePaths)).toEqual({
      allowed: false,
      reason: 'not_allowed',
    });
  });

  it('refuses empty, NUL, relative and missing paths', async () => {
    expect(await resolveRepository([repo], '', nodePaths)).toMatchObject({
      reason: 'invalid_path',
    });
    expect(await resolveRepository([repo], `${repo}\0`, nodePaths)).toMatchObject({
      reason: 'invalid_path',
    });
    expect(await resolveRepository([repo], 'repo/src', nodePaths)).toMatchObject({
      reason: 'not_absolute',
    });
    expect(await resolveRepository([repo], join(repo, 'missing'), nodePaths)).toMatchObject({
      reason: 'not_found',
    });
  });

  it('skips relative and missing roots and refuses with an empty list', async () => {
    expect(await resolveRepository([], repo, nodePaths)).toMatchObject({ reason: 'not_allowed' });
    expect(
      await resolveRepository(['repo', join(base, 'gone'), repo], join(repo, 'src'), nodePaths),
    ).toMatchObject({ allowed: true, root: repo });
  });

  it('accepts a file inside the root (callers decide whether it must be a directory)', async () => {
    expect(await resolveRepository([repo], join(repo, 'file.txt'), nodePaths)).toMatchObject({
      allowed: true,
    });
  });
});
