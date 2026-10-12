import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../scripts/check-argv-policy.mjs', import.meta.url));
const SOURCE = fileURLToPath(new URL('.', import.meta.url));
const SPAWN = join('adapters', 'claude-code', 'spawn.ts');

interface GateResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function gate(dir?: string): Promise<GateResult> {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      dir === undefined ? [SCRIPT] : [SCRIPT, dir],
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

/** The CI gate `scripts/check-argv-policy.mjs` (D13, 02 W11), run as the build runs it. */
describe('argv policy gate', () => {
  let dir: string;
  let spawnSource: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'remotectl-gate-'));
    await cp(SOURCE, dir, { recursive: true });
    spawnSource = await readFile(join(dir, SPAWN), 'utf8');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function plant(file: string, text: string): Promise<void> {
    await writeFile(join(dir, file), text);
  }

  async function expectViolation(pattern: RegExp): Promise<void> {
    const result = await gate(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(pattern);
  }

  it('passes on the shipped sources (default directory)', async () => {
    const result = await gate();
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^argv policy: ok/);
  });

  it('passes on an unmodified copy', async () => {
    expect((await gate(dir)).code).toBe(0);
  });

  it.each([
    '--dangerously-skip-permissions',
    'bypassPermissions',
    '--allowedTools',
    '--settings',
    '--permission-mode',
  ])('fails on a planted forbidden token %s', async (token) => {
    await plant('core/planted.ts', `export const mode = '${token}';\n`);
    await expectViolation(new RegExp(`core/planted\\.ts:1: forbidden token ${token}`));
  });

  it('fails on a forbidden token added to the start argv', async () => {
    await plant(SPAWN, spawnSource.replace("['--bg',", "['--bg', '--permission-mode',"));
    await expectViolation(/forbidden token --permission-mode/);
  });

  it('fails on updatedInput outside decide.ts and allows it there', async () => {
    await plant('core/planted.ts', 'export const x = { updatedInput: {} };\n');
    await expectViolation(/updatedInput outside claude-code\/decide\.ts/);
    await rm(join(dir, 'core/planted.ts'));
    await plant('adapters/claude-code/decide.ts', 'export const x = { updatedInput: {} };\n');
    expect((await gate(dir)).code).toBe(0);
  });

  it.each([
    ["import { exec } from 'node:child_process';\n", 'static import'],
    ["export { spawn } from 'child_process';\n", 're-export'],
    ["import cp = require('child_process');\n", 'import ='],
    ["export const m = () => import('node:child_process');\n", 'dynamic import'],
    ["export const m = require('child_process');\n", 'require'],
  ])('fails on child_process outside spawn.ts: %s', async (text) => {
    await plant('core/planted.ts', text);
    await expectViolation(/core\/planted\.ts:1: .*child_process/);
  });

  it('fails on a dynamic import with a computed specifier', async () => {
    await plant(
      'core/planted.ts',
      "const n = 'child' + '_process';\nexport const m = import(n);\n",
    );
    await expectViolation(/core\/planted\.ts:2: /);
  });

  it('fails when spawn.ts imports more than spawn', async () => {
    await plant(SPAWN, spawnSource.replace('import { spawn }', 'import { exec, spawn }'));
    await expectViolation(/spawn\.ts:\d+: /);
  });

  it('fails on a non-literal argv', async () => {
    await plant(
      SPAWN,
      spawnSource.replace(
        "return ['--bg', '--name', checkName(name), checkPrompt(prompt)];",
        "const extra = ['--bg'];\n  return [...extra, '--name', checkName(name), checkPrompt(prompt)];",
      ),
    );
    await expectViolation(/spawn\.ts:\d+: /);
  });

  it('fails when argv does not come from an *Argv builder', async () => {
    await plant(
      SPAWN,
      spawnSource.replace(
        'const argv = startSessionArgv(options.name, options.prompt);',
        'const argv = [options.name, options.prompt];',
      ),
    );
    await expectViolation(/spawn\.ts:\d+: /);
  });

  it('fails when the shell is enabled', async () => {
    await plant(SPAWN, spawnSource.replace('shell: false', 'shell: true'));
    await expectViolation(/spawn\.ts:\d+: .*shell/);
  });
});
