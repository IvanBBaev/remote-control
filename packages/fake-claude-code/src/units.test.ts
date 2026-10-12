import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { systemClock } from './adapters/system-clock.js';
import { systemRandom } from './adapters/system-random.js';
import { defaultTimeoutSeconds, isHookEventName } from './events.js';
import { HookRunner } from './hook-runner.js';
import { prefixedId, uuidV4 } from './ids.js';
import { matcherMatches } from './matcher.js';
import { configDir, globalConfigPath, homeDir, projectDirName, transcriptPath } from './paths.js';
import { isWorkspaceTrusted, trustWorkspace } from './roster.js';
import { withPrompt } from './scenarios.js';
import { spawnHook } from './spawn-hook.js';
import { TempEnv } from './test-env.js';
import { seededRandom, steppingClock } from './testing.js';

describe('matcher', () => {
  it('treats absent, empty and * as match-all, word lists as exact names, the rest as regex', () => {
    expect(matcherMatches(undefined, 'Bash')).toBe(true);
    expect(matcherMatches('', undefined)).toBe(true);
    expect(matcherMatches('Bash', undefined)).toBe(false);
    expect(matcherMatches('Bash', 'BashOutput')).toBe(false);
    expect(matcherMatches('mcp__.*', 'mcp__github__x')).toBe(true);
    expect(matcherMatches('(', 'x')).toBe(false);
  });
});

describe('paths', () => {
  it('honours HOME, USERPROFILE and CLAUDE_CONFIG_DIR', () => {
    expect(homeDir({ USERPROFILE: 'C:\\u' })).toBe('C:\\u');
    expect(homeDir({})).toBeTypeOf('string');
    expect(configDir({ CLAUDE_CONFIG_DIR: '/c' })).toBe('/c');
    expect(globalConfigPath({ CLAUDE_CONFIG_DIR: '/c' })).toBe(join('/c', '.claude.json'));
    expect(globalConfigPath({ HOME: '/h' })).toBe(join('/h', '.claude.json'));
    expect(transcriptPath({ HOME: '/h' }, '/a/b.c', 's')).toBe(
      join('/h', '.claude', 'projects', '-a-b-c', 's.jsonl'),
    );
  });

  it('truncates long project names and suffixes a stable hash', () => {
    const long = `/${'x'.repeat(300)}`;
    const name = projectDirName(long);
    expect(name).toHaveLength(209);
    expect(name).toBe(projectDirName(long));
    expect(name).not.toBe(projectDirName(`${long}y`));
  });
});

describe('ids, ports and events', () => {
  it('draws UUIDs and prefixed ids from the Random port', () => {
    expect(uuidV4(seededRandom(1))).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(uuidV4(seededRandom(1))).toBe(uuidV4(seededRandom(1)));
    expect(prefixedId('toolu_', seededRandom(0), 4)).toMatch(/^toolu_[0-9a-f]{8}$/);
    expect(uuidV4(systemRandom)).not.toBe(uuidV4(systemRandom));
    expect(systemClock.now()).toBeGreaterThan(0);
    const clock = steppingClock(10, 5);
    expect([clock.now(), clock.now()]).toEqual([10, 15]);
  });

  it('knows the events and their default timeouts', () => {
    expect(isHookEventName('Stop')).toBe(true);
    expect(isHookEventName('TaskCreated')).toBe(false);
    expect(defaultTimeoutSeconds('UserPromptSubmit')).toBe(30);
    expect(defaultTimeoutSeconds('SessionEnd')).toBe(1.5);
    expect(defaultTimeoutSeconds('PermissionRequest')).toBe(600);
  });

  it('withPrompt replaces the first prompt or prepends one', () => {
    expect(withPrompt({ name: 'x', steps: [] }, undefined)).toEqual({ name: 'x', steps: [] });
    expect(withPrompt({ name: 'x', steps: [] }, 'hi').steps).toEqual([
      { kind: 'prompt', text: 'hi' },
    ]);
    const two = withPrompt(
      {
        name: 'x',
        steps: [
          { kind: 'prompt', text: 'a' },
          { kind: 'prompt', text: 'b' },
        ],
      },
      'c',
    );
    expect(two.steps).toEqual([
      { kind: 'prompt', text: 'c' },
      { kind: 'prompt', text: 'b' },
    ]);
  });
});

describe('workspace trust', () => {
  it('trusts a folder and its subfolders, nothing else', () => {
    const t = new TempEnv();
    try {
      expect(isWorkspaceTrusted(t.env, t.cwd)).toBe(false);
      trustWorkspace(t.env, t.cwd);
      expect(isWorkspaceTrusted(t.env, join(t.cwd, 'sub'))).toBe(true);
      expect(isWorkspaceTrusted(t.env, `${t.cwd}-other`)).toBe(false);
      expect(isWorkspaceTrusted({ ...t.env, CLAUDE_CONFIG_DIR: join(t.root, 'cfg') }, t.cwd)).toBe(
        false,
      );
    } finally {
      t.cleanup();
    }
  });
});

describe('spawnHook and HookRunner edges', () => {
  it('reports a command that cannot start or ignores stdin as an error, not a crash', async () => {
    const t = new TempEnv();
    try {
      const result = await spawnHook({
        command: `"${process.execPath}" -e "process.exit(3)"`,
        stdin: 'x'.repeat(1 << 20),
        cwd: t.cwd,
        env: t.env,
        timeoutMs: 10_000,
      });
      expect(result).toMatchObject({ exitCode: 3, timedOut: false });
      const missing = await spawnHook({
        command: 'x',
        stdin: '',
        cwd: join(t.root, 'missing'),
        env: t.env,
        timeoutMs: 10_000,
      });
      expect(missing.spawnError).toBeTypeOf('string');
    } finally {
      t.cleanup();
    }
  });

  it('plain-text stdout is fine, non-object JSON is an error, SessionEnd timeouts are capped', async () => {
    const t = new TempEnv();
    try {
      const settings = {
        disableAllHooks: false,
        warnings: [],
        groups: {
          Notification: [
            {
              source: 's',
              hooks: [
                { type: 'command' as const, command: t.hook(`process.stdout.write('hello');`) },
              ],
            },
            {
              source: 's',
              hooks: [
                {
                  type: 'command' as const,
                  command: t.hook(
                    `process.stdout.write('{}'); process.stdout.write('[]'.slice(2));`,
                  ),
                },
              ],
            },
            {
              source: 's',
              hooks: [
                {
                  type: 'command' as const,
                  command: t.hook(
                    `process.stdout.write(JSON.stringify({ systemMessage: 'note', hookSpecificOutput: { additionalContext: 'ctx' } }));`,
                  ),
                },
              ],
            },
          ],
          SessionStart: [
            {
              source: 's',
              hooks: [
                {
                  type: 'command' as const,
                  command: t.hook(`process.stdout.write(' {"a": [1] ');`),
                },
              ],
            },
          ],
          PreCompact: [
            {
              source: 's',
              hooks: [
                {
                  type: 'command' as const,
                  command: t.hook(`process.exit(2);`),
                  onFailure: 'block' as const,
                },
              ],
            },
          ],
        },
      };
      const runner = new HookRunner({ settings, cwd: t.cwd, env: t.env, clock: steppingClock() });
      const note = await runner.fire('Notification', {
        hook_event_name: 'Notification',
        notification_type: 'idle_prompt',
      });
      expect(note.outcomes.map((outcome) => outcome.status)).toEqual(['ok', 'ok', 'ok']);
      expect(note).toMatchObject({
        systemMessages: ['note'],
        additionalContext: ['ctx'],
        decision: 'none',
      });
      const start = await runner.fire('SessionStart', {
        hook_event_name: 'SessionStart',
        source: 'startup',
      });
      expect(start.errors[0]).toMatch(/invalid JSON/);
      // onFailure on an event that cannot block has nothing to turn into a block.
      const compact = await runner.fire('PreCompact', {
        hook_event_name: 'PreCompact',
        trigger: 'auto',
      });
      expect(compact).toMatchObject({
        decision: 'none',
        errors: [expect.stringMatching(/exit 2/) as unknown],
      });
    } finally {
      t.cleanup();
    }
  });
});
