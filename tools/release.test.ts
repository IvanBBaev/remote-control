import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  type AgentManifest,
  isNewer,
  manifestProblems,
  packedManifestProblems,
  parseVersion,
  REPOSITORY_URL,
  rewriteManifestVersion,
  rewriteVersionSource,
  tagFor,
  tarballProblems,
} from './release.js';

const read = (path: string): Promise<string> =>
  readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const good: AgentManifest = {
  name: 'remotectl',
  version: '0.1.0',
  files: ['dist'],
  bin: { remotectl: 'dist/cli.mjs' },
  scripts: { build: 'tsdown' },
  repository: { url: REPOSITORY_URL, directory: 'apps/agent' },
  publishConfig: { access: 'public', provenance: true },
};

describe('release versions (M1-09)', () => {
  it('parses x.y.z only', () => {
    expect(parseVersion('0.1.0')).toEqual([0, 1, 0]);
    expect(parseVersion('1.2.3-beta.1')).toBeUndefined();
    expect(parseVersion('01.0.0')).toBeUndefined();
  });

  it('accepts only strictly newer versions', () => {
    expect(isNewer('0.1.0', '0.0.1')).toBe(true);
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
    expect(isNewer('0.0.9', '0.1.0')).toBe(false);
    expect(isNewer('next', '0.1.0')).toBe(false);
  });

  it('rewrites package.json and version.ts in place', async () => {
    const manifest = await read('apps/agent/package.json');
    const bumped = rewriteManifestVersion(manifest, '0.1.0');
    expect((JSON.parse(bumped) as AgentManifest).version).toBe('0.1.0');
    expect(bumped.replace('"version": "0.1.0"', '')).toBe(
      manifest.replace(/"version": "[^"]*"/, ''),
    );
    const source = await read('apps/agent/src/version.ts');
    expect(rewriteVersionSource(source, '0.1.0')).toContain(
      "export const AGENT_VERSION = '0.1.0';",
    );
    expect(() => rewriteVersionSource('// nothing', '0.1.0')).toThrow(/AGENT_VERSION/);
    expect(() => rewriteManifestVersion('{}', '0.1.0')).toThrow(/version/);
  });
});

describe('release manifest check (M1-09)', () => {
  it('accepts a publishable manifest under its own tag', () => {
    expect(tagFor('0.1.0')).toBe('remotectl-v0.1.0');
    expect(manifestProblems(good, 'remotectl-v0.1.0')).toEqual([]);
  });

  it('rejects a tag that does not match the version', () => {
    expect(manifestProblems(good, 'remotectl-v0.2.0')).toEqual([
      'tag remotectl-v0.2.0 does not match remotectl-v0.1.0',
    ]);
  });

  it('rejects install scripts, runtime deps, privacy and missing provenance', () => {
    const bad: AgentManifest = {
      ...good,
      name: 'other',
      version: 'x',
      private: true,
      files: ['dist', 'src'],
      bin: {},
      scripts: { postinstall: 'node x.js' },
      dependencies: { zod: '4' },
      repository: { url: 'https://example.com/fork.git' },
      publishConfig: { access: 'restricted' },
    };
    expect(manifestProblems(bad, 'remotectl-vx')).toHaveLength(11);
  });

  it('passes for the committed apps/agent/package.json at its own tag', async () => {
    const manifest = JSON.parse(await read('apps/agent/package.json')) as AgentManifest;
    expect(manifestProblems(manifest, tagFor(manifest.version ?? ''))).toEqual([]);
  });
});

describe('release tarball check (M1-09)', () => {
  const entries = [
    'package/package.json',
    'package/README.md',
    'package/dist/cli.mjs',
    'package/dist/cli.mjs.map',
    'package/dist/hook.cjs',
  ];

  it('accepts the whitelisted layout', () => {
    expect(tarballProblems(entries)).toEqual([]);
  });

  it('rejects sources, nested files and a missing hook bundle', () => {
    expect(
      tarballProblems([
        'package/package.json',
        'package/dist/cli.mjs',
        'package/src/index.ts',
        'package/dist/a/b.js',
      ]),
    ).toEqual([
      'unexpected file package/src/index.ts',
      'unexpected file package/dist/a/b.js',
      'missing package/dist/hook.cjs',
    ]);
  });

  it('rejects workspace ranges and source exports in the packed manifest', () => {
    expect(packedManifestProblems({ exports: { './package.json': './package.json' } })).toEqual([]);
    expect(
      packedManifestProblems({
        exports: { '.': './src/index.ts' },
        devDependencies: { x: 'workspace:*' },
      }),
    ).toEqual(['packed manifest still has workspace: ranges', 'packed exports point into src/']);
  });
});

describe('release workflow (M1-09)', () => {
  it('publishes with OIDC provenance and never with a token', async () => {
    const workflow = await read('.github/workflows/release.yml');
    expect(workflow).toMatch(/tags:\s*\n\s*- 'remotectl-v\*'/);
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('npm publish');
    expect(workflow).toContain('--provenance');
    expect(workflow).toContain('npm audit signatures');
    expect(workflow).toContain('tools/release.ts verify');
    expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
  });
});
