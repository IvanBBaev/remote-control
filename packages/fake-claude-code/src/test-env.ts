import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Env } from './paths.js';
import { trustWorkspace } from './roster.js';

/** A hook entry as written in settings.json. */
export interface HookEntry {
  readonly type?: string;
  readonly command: string;
  readonly timeout?: number;
  readonly async?: boolean;
  readonly onFailure?: string;
}

export type HooksConfig = Record<string, { matcher?: string; hooks: HookEntry[] }[]>;

/**
 * A throwaway HOME + project directory under `os.tmpdir()` for tests. Hook scripts are
 * `.mjs` files run as `"<node>" "<script>"`, which every platform shell accepts the same
 * way (OS-portable, no shell syntax). Every hook invocation appends its stdin payload to
 * `calls.jsonl`, so tests can assert on exactly what Claude Code would have sent.
 */
export class TempEnv {
  readonly root: string;
  readonly home: string;
  readonly cwd: string;
  readonly env: Env;
  readonly #log: string;
  #scripts = 0;

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), 'fake-claude-'));
    this.home = join(this.root, 'home');
    this.cwd = join(this.root, 'work', 'project');
    mkdirSync(this.home, { recursive: true });
    mkdirSync(this.cwd, { recursive: true });
    this.#log = join(this.root, 'calls.jsonl');
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.CLAUDE_CONFIG_DIR;
    delete env.FAKE_CLAUDE_VERSION;
    delete env.FAKE_CLAUDE_SCENARIO;
    env.HOME = this.home;
    env.USERPROFILE = this.home;
    this.env = env;
  }

  /**
   * Writes a hook script and returns its command. `body` runs after `input` (the parsed
   * stdin payload) is available; it may print JSON, write to stderr or exit.
   */
  hook(body: string): string {
    this.#scripts += 1;
    const script = join(this.root, `hook-${String(this.#scripts)}.mjs`);
    writeFileSync(
      script,
      [
        "import { appendFileSync, readFileSync, existsSync } from 'node:fs';",
        'const chunks = [];',
        'for await (const chunk of process.stdin) chunks.push(chunk);',
        "const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));",
        `const extra = { cwdSeen: process.cwd(), projectDir: process.env.CLAUDE_PROJECT_DIR, script: ${String(this.#scripts)} };`,
        `appendFileSync(${JSON.stringify(this.#log)}, JSON.stringify({ input, ...extra }) + '\\n');`,
        body,
      ].join('\n'),
    );
    return `"${process.execPath}" "${script}"`;
  }

  /** Writes user-level `~/.claude/settings.json`. */
  userSettings(settings: { hooks?: HooksConfig; disableAllHooks?: boolean } | string): void {
    this.#writeSettings(join(this.home, '.claude', 'settings.json'), settings);
  }

  /** Writes `<cwd>/.claude/settings.json` or `settings.local.json`. */
  projectSettings(
    settings: { hooks?: HooksConfig; disableAllHooks?: boolean } | string,
    local = false,
  ): void {
    const file = local ? 'settings.local.json' : 'settings.json';
    this.#writeSettings(join(this.cwd, '.claude', file), settings);
  }

  trust(): void {
    trustWorkspace(this.env, this.cwd);
  }

  /** Every recorded hook invocation, in order. */
  calls(): {
    input: Record<string, unknown>;
    cwdSeen: string;
    projectDir: string;
    script: number;
  }[] {
    let text: string;
    try {
      text = readFileSync(this.#log, 'utf8');
    } catch {
      return [];
    }
    return text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as ReturnType<TempEnv['calls']>[number]);
  }

  cleanup(): void {
    // Windows keeps a killed hook's working directory locked for a moment (EBUSY). Retry for
    // a few seconds; a directory that stays locked is a leaked temp dir, not a test failure.
    try {
      rmSync(this.root, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || (code !== 'EBUSY' && code !== 'EPERM')) throw error;
    }
  }

  #writeSettings(file: string, settings: object | string): void {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(
      file,
      typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2),
    );
  }
}
