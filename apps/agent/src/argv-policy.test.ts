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
const LAUNCHCTL = join('adapters', 'launchd', 'launchctl.ts');
const SYSTEMCTL = join('adapters', 'systemd', 'systemctl.ts');
const SCHTASKS = join('adapters', 'windows', 'schtasks.ts');

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
  let launchctlSource: string;
  let systemctlSource: string;
  let schtasksSource: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'remotectl-gate-'));
    await cp(SOURCE, dir, { recursive: true });
    spawnSource = await readFile(join(dir, SPAWN), 'utf8');
    launchctlSource = await readFile(join(dir, LAUNCHCTL), 'utf8');
    systemctlSource = await readFile(join(dir, SYSTEMCTL), 'utf8');
    schtasksSource = await readFile(join(dir, SCHTASKS), 'utf8');
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

  describe('updatedInput (D11, M1-01)', () => {
    const DECIDE = join('adapters', 'claude-code', 'decide.ts');
    const GUARDED =
      "import { ASK_USER_QUESTION } from '../../core/hook-dispatcher.js';\n" +
      'export function answer(tool: string) {\n' +
      '  if (tool !== ASK_USER_QUESTION) return {};\n' +
      '  return { updatedInput: {} };\n' +
      '}\n';

    it('fails on updatedInput in any other module, even in a comment', async () => {
      await plant('core/planted.ts', '// updatedInput\nexport const x = 1;\n');
      await expectViolation(
        /core\/planted\.ts:1: updatedInput outside adapters\/claude-code\/decide\.ts/,
      );
    });

    it('fails on updatedInput in a test file other than decide.test.ts', async () => {
      await plant('core/planted.test.ts', 'export const x = { updatedInput: {} };\n');
      await expectViolation(/core\/planted\.test\.ts:1: updatedInput outside/);
    });

    it('fails on a decide.ts at another path', async () => {
      await plant('core/decide.ts', GUARDED);
      await expectViolation(/core\/decide\.ts:4: updatedInput outside/);
    });

    it.each([
      ['an ASK_USER_QUESTION check', GUARDED],
      ["an 'AskUserQuestion' check", GUARDED.replace('ASK_USER_QUESTION)', "'AskUserQuestion')")],
    ])('allows one updatedInput property in decide.ts behind %s', async (_name, text) => {
      await plant(DECIDE, text);
      expect((await gate(dir)).code).toBe(0);
    });

    it.each([
      [
        'a check for another tool',
        GUARDED.replace('tool !== ASK_USER_QUESTION', "tool !== 'Bash'"),
        /decide\.ts:4: updatedInput without an ASK_USER_QUESTION check/,
      ],
      [
        'no function at all',
        'export const x = { updatedInput: {} };\n',
        /decide\.ts:1: updatedInput without an ASK_USER_QUESTION check/,
      ],
      [
        'a second property',
        `${GUARDED}export const y = { updatedInput: {} };\n`,
        /decide\.ts:6: updatedInput more than once/,
      ],
      [
        'a string',
        GUARDED.replace('return { updatedInput: {} }', "return 'updatedInput'"),
        /decide\.ts:4: updatedInput other than as an object property/,
      ],
      [
        'a property read',
        GUARDED.replace('{ updatedInput: {} }', '{ x: tool.updatedInput }'),
        /decide\.ts:4: updatedInput other than as an object property/,
      ],
    ])('fails on updatedInput in decide.ts as %s', async (_name, text, pattern) => {
      await plant(DECIDE, text);
      await expectViolation(pattern);
    });
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

  describe('launchctl module (M0-24)', () => {
    it('still rejects child_process in any other module, even next to launchctl.ts', async () => {
      await plant(
        join('adapters', 'launchd', 'other.ts'),
        "import { spawn } from 'node:child_process';\nexport { spawn };\n",
      );
      await expectViolation(/adapters\/launchd\/other\.ts:1: imports node:child_process/);
    });

    it('allows launchctl.ts only at its exact path', async () => {
      await plant(join('core', 'launchctl.ts'), launchctlSource);
      await expectViolation(/core\/launchctl\.ts:\d+: imports node:child_process/);
    });

    it('fails when the executable is not the literal /bin/launchctl', async () => {
      await plant(
        LAUNCHCTL,
        launchctlSource.replace(
          "spawn('/bin/launchctl', argv",
          "spawn(process.env['X'] ?? '', argv",
        ),
      );
      await expectViolation(
        /launchctl\.ts:\d+: spawn command must be the literal "\/bin\/launchctl"/,
      );
    });

    it('fails when the shell is enabled', async () => {
      await plant(LAUNCHCTL, launchctlSource.replace('shell: false', 'shell: true'));
      await expectViolation(/launchctl\.ts:\d+: .*shell/);
    });

    it('fails when it imports more than spawn', async () => {
      await plant(LAUNCHCTL, launchctlSource.replace('import { spawn }', 'import { exec, spawn }'));
      await expectViolation(/launchctl\.ts:\d+: child_process import "exec"/);
    });

    it('fails on a non-literal argv', async () => {
      await plant(
        LAUNCHCTL,
        launchctlSource.replace(
          "return ['print', checkServiceTarget(serviceTarget)];",
          "const extra = ['print'];\n  return [...extra, checkServiceTarget(serviceTarget)];",
        ),
      );
      await expectViolation(/launchctl\.ts:\d+: printArgv must be a single/);
    });

    it('fails when argv does not come from an *Argv builder', async () => {
      await plant(
        LAUNCHCTL,
        launchctlSource.replace(
          'const argv = printArgv(serviceTarget);',
          "const argv = ['print', serviceTarget];",
        ),
      );
      await expectViolation(/launchctl\.ts:\d+: `argv` must be the result/);
    });
  });

  describe('systemctl module (M1-08)', () => {
    it('allows only /usr/bin/systemctl and /usr/bin/loginctl', async () => {
      expect(systemctlSource).toContain("spawn('/usr/bin/systemctl', argv");
      expect(systemctlSource).toContain("spawn('/usr/bin/loginctl', argv");
      await plant(
        SYSTEMCTL,
        systemctlSource.replace("spawn('/usr/bin/loginctl', argv", "spawn('/bin/sh', argv"),
      );
      await expectViolation(
        /systemctl\.ts:\d+: spawn command must be the literal "\/usr\/bin\/systemctl" or "\/usr\/bin\/loginctl"/,
      );
    });

    it('fails on a non-literal executable', async () => {
      await plant(
        SYSTEMCTL,
        systemctlSource.replace(
          "spawn('/usr/bin/systemctl', argv",
          'spawn(`/usr/bin/systemctl`, argv',
        ),
      );
      await expectViolation(/systemctl\.ts:\d+: spawn command must be the literal/);
    });

    it('allows systemctl.ts only at its exact path', async () => {
      await plant(join('core', 'systemctl.ts'), systemctlSource);
      await expectViolation(/core\/systemctl\.ts:\d+: imports node:child_process/);
    });

    it('fails when the shell is enabled or argv is not built by an *Argv function', async () => {
      await plant(
        SYSTEMCTL,
        systemctlSource
          .replace('shell: false', 'shell: true')
          .replace('const argv = daemonReloadArgv();', "const argv = ['--user', 'daemon-reload'];"),
      );
      const result = await gate(dir);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/systemctl\.ts:\d+: spawn must pass shell: false/);
      expect(result.stderr).toMatch(/systemctl\.ts:\d+: `argv` must be the result/);
    });

    it('fails on a spread in an *Argv builder', async () => {
      await plant(
        SYSTEMCTL,
        systemctlSource.replace(
          "return ['enable-linger'];",
          "return ['enable-linger', ...process.argv];",
        ),
      );
      await expectViolation(/systemctl\.ts:\d+: enableLingerArgv: spread in argv/);
    });
  });

  describe('schtasks module (M1-08)', () => {
    it('allows only C:\\Windows\\System32\\schtasks.exe', async () => {
      expect(schtasksSource).toContain("spawn('C:\\\\Windows\\\\System32\\\\schtasks.exe', argv");
      await plant(
        SCHTASKS,
        schtasksSource.replace(
          "spawn('C:\\\\Windows\\\\System32\\\\schtasks.exe', argv",
          "spawn('schtasks.exe', argv",
        ),
      );
      await expectViolation(
        /schtasks\.ts:\d+: spawn command must be the literal "C:\\Windows\\System32\\schtasks\.exe"/,
      );
    });

    it('allows schtasks.ts only at its exact path', async () => {
      await plant(join('adapters', 'windows', 'other.ts'), schtasksSource);
      await expectViolation(/adapters\/windows\/other\.ts:\d+: imports node:child_process/);
    });

    it('fails when it imports more than spawn', async () => {
      await plant(
        SCHTASKS,
        schtasksSource.replace('import { spawn }', 'import { execFile, spawn }'),
      );
      await expectViolation(/schtasks\.ts:\d+: child_process import "execFile"/);
    });
  });
});
