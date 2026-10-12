import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

// Lints fixture code as if it lived inside a package, so the guard rules from
// eslint.config.mjs are proven to fire (M0-01 AC).
const root = fileURLToPath(new URL('..', import.meta.url));
// The fixtures are linted under virtual paths that belong to no tsconfig, so type-aware
// parsing is switched off; the guard rules are syntactic and do not need it.
const eslint = new ESLint({
  cwd: root,
  overrideConfig: [
    tseslint.configs.disableTypeChecked,
    { languageOptions: { parserOptions: { projectService: false, project: null } } },
  ],
});

async function ruleIdsFor(fixture: string, asPath: string): Promise<string[]> {
  const code = await readFile(new URL(`./lint-fixtures/${fixture}`, import.meta.url), 'utf8');
  const [result] = await eslint.lintText(code, { filePath: `${root}${asPath}` });
  return (result?.messages ?? []).map((m) => m.ruleId ?? `parse-error: ${m.message}`);
}

describe('lint guard rules', () => {
  it('rejects Date.now() and Math.random() in a test file', async () => {
    const ids = await ruleIdsFor('direct-clock.ts', 'packages/protocol/src/direct-clock.test.ts');
    expect(ids.filter((id) => id === 'no-restricted-properties')).toHaveLength(2);
  });

  it('allows the clock and RNG inside the system adapters', async () => {
    const ids = await ruleIdsFor('direct-clock.ts', 'apps/relay/src/adapters/system-clock.ts');
    expect(ids).not.toContain('no-restricted-properties');
  });

  it('rejects node:crypto outside packages/crypto adapters', async () => {
    const ids = await ruleIdsFor('node-crypto.ts', 'apps/agent/src/core/keys.ts');
    expect(ids).toContain('no-restricted-imports');
  });
});
