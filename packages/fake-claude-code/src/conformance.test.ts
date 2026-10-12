import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readAgentEntries } from './roster.js';
import { SCENARIOS, type Scenario } from './scenarios.js';
import { FakeSession, type SessionResult } from './session.js';
import { TempEnv } from './test-env.js';
import { seededRandom, steppingClock } from './testing.js';

/**
 * Conformance suite (ROADMAP M0-07): every case is named after the 04 §2 / D10 / D11
 * sentence it checks. OS-portable by construction: paths via node:path, hooks are
 * `"<node>" "<script.mjs>"` commands, no shell syntax.
 */

let t: TempEnv;

beforeEach(() => {
  t = new TempEnv();
});

afterEach(() => {
  t.cleanup();
});

const ALLOW = `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, decision: { behavior: 'allow' } } }));`;

function play(scenario: Scenario, extra: { sessionId?: string } = {}): Promise<SessionResult> {
  return new FakeSession({
    env: t.env,
    cwd: t.cwd,
    clock: steppingClock(),
    random: seededRandom(7),
    scenario,
    ...extra,
  }).run();
}

function events(result: SessionResult): string[] {
  return result.fired.map((fire) => fire.event);
}

describe('04 §2 hook contract', () => {
  it('hooks from user, project and local settings files all load and run together (04 §2.5)', async () => {
    t.userSettings({ hooks: { Stop: [{ hooks: [{ type: 'command', command: t.hook('') }] }] } });
    t.projectSettings({ hooks: { Stop: [{ hooks: [{ type: 'command', command: t.hook('') }] }] } });
    t.projectSettings(
      { hooks: { Stop: [{ hooks: [{ type: 'command', command: t.hook('') }] }] } },
      true,
    );
    await play(SCENARIOS.stop as Scenario);
    expect(
      t
        .calls()
        .map((call) => call.script)
        .sort(),
    ).toEqual([1, 2, 3]);
  });

  it('a session fires SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd in order (07 §5.3)', async () => {
    const result = await play(SCENARIOS.tools as Scenario);
    expect(events(result)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PreToolUse',
      'PermissionRequest',
      'Notification',
      'PostToolUse',
      'PreToolUse',
      'PostToolUse',
      'Stop',
      'SessionEnd',
    ]);
  });

  it('common input fields: session_id, transcript_path, cwd, permission_mode, hook_event_name, prompt_id on turn-scoped events (04 §2.1)', async () => {
    const all = { hooks: [{ type: 'command', command: t.hook('') }] };
    t.userSettings({
      hooks: {
        SessionStart: [all],
        UserPromptSubmit: [all],
        PreToolUse: [all],
        PostToolUse: [all],
      },
    });
    const result = await play(SCENARIOS.tools as Scenario);
    const calls = t.calls().map((call) => call.input);
    for (const input of calls) {
      expect(input).toMatchObject({
        session_id: result.sessionId,
        transcript_path: result.transcriptPath,
        cwd: t.cwd,
        permission_mode: 'default',
      });
    }
    const start = calls.find((input) => input.hook_event_name === 'SessionStart');
    expect(start).toMatchObject({ source: 'startup' });
    expect(start).not.toHaveProperty('prompt_id');
    const pre = calls.find((input) => input.hook_event_name === 'PreToolUse');
    expect(Object.keys(pre ?? {}).sort()).toEqual(
      [
        'cwd',
        'hook_event_name',
        'permission_mode',
        'prompt_id',
        'session_id',
        'tool_input',
        'tool_name',
        'tool_use_id',
        'transcript_path',
      ].sort(),
    );
    const post = calls.find((input) => input.hook_event_name === 'PostToolUse');
    expect(post).toMatchObject({ tool_name: 'Read', tool_use_id: pre?.tool_use_id });
    expect(post).toHaveProperty('tool_response');
    expect(post).toHaveProperty('duration_ms');
  });

  it('PermissionRequest carries tool_name, tool_input, permission_suggestions and no tool_use_id (04 §2.2)', async () => {
    t.userSettings({
      hooks: {
        PermissionRequest: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: t.hook(ALLOW) }] },
        ],
      },
    });
    await play(SCENARIOS.permission as Scenario);
    const [call] = t.calls();
    expect(call?.input).toMatchObject({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf node_modules' },
      permission_suggestions: [
        { type: 'addRules', behavior: 'allow', destination: 'localSettings' },
      ],
    });
    expect(call?.input).not.toHaveProperty('tool_use_id');
  });

  it('the hook runs in the session cwd with CLAUDE_PROJECT_DIR set (07 §2.1)', async () => {
    t.userSettings({ hooks: { Stop: [{ hooks: [{ type: 'command', command: t.hook('') }] }] } });
    await play(SCENARIOS.stop as Scenario);
    const [call] = t.calls();
    expect(realpathSync(call?.cwdSeen ?? '')).toBe(realpathSync(t.cwd));
    expect(call?.projectDir).toBe(t.cwd);
  });

  it('exit 0 with decision.behavior allow runs the tool with updatedInput (04 §2.2)', async () => {
    const body = `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { command: 'rm -rf node_modules/.cache' } } } }));`;
    t.userSettings({
      hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: t.hook(body) }] }] },
    });
    const result = await play(SCENARIOS.permission as Scenario);
    expect(result.tools).toEqual([
      expect.objectContaining({
        outcome: 'ran',
        decidedBy: 'PermissionRequest',
        input: { command: 'rm -rf node_modules/.cache' },
      }),
    ]);
    expect(events(result)).toContain('PostToolUse');
    expect(events(result)).not.toContain('Notification');
  });

  it('decision.behavior deny with interrupt: true denies the tool and stops Claude (04 §2.2)', async () => {
    const body = `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied from phone', interrupt: true } } }));`;
    t.userSettings({
      hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: t.hook(body) }] }] },
    });
    const result = await play(SCENARIOS.permission as Scenario);
    expect(result.tools[0]).toMatchObject({ outcome: 'denied', reason: 'Denied from phone' });
    expect(result.stoppedEarly).toMatch(/interrupted/);
    expect(events(result)).not.toContain('Stop');
    expect(events(result).at(-1)).toBe('SessionEnd');
  });

  it('exit 2 is not honoured for PermissionRequest: no decision, the terminal prompt appears (04 §2.2, D10)', async () => {
    t.userSettings({
      hooks: {
        PermissionRequest: [
          {
            hooks: [
              { type: 'command', command: t.hook(`process.stderr.write('no'); process.exit(2);`) },
            ],
          },
        ],
        Notification: [
          { matcher: 'permission_prompt', hooks: [{ type: 'command', command: t.hook('') }] },
        ],
      },
    });
    const result = await play(SCENARIOS.held as Scenario);
    const permission = result.fired.find((fire) => fire.event === 'PermissionRequest');
    expect(permission?.decision).toBe('none');
    expect(permission?.errors[0]).toMatch(/exit 2 is not honoured/);
    expect(t.calls().map((call) => call.input.notification_type)).toContain('permission_prompt');
    expect(result.tools[0]).toMatchObject({ outcome: 'denied', decidedBy: 'terminal' });
  });

  it('exit 2 on PreToolUse blocks the tool with stderr as the reason (04 §2.1)', async () => {
    t.userSettings({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: t.hook(`process.stderr.write('blocked by policy'); process.exit(2);`),
              },
            ],
          },
        ],
      },
    });
    const result = await play(SCENARIOS.permission as Scenario);
    expect(result.tools[0]).toMatchObject({
      outcome: 'denied',
      decidedBy: 'PreToolUse',
      reason: 'blocked by policy',
    });
    expect(events(result)).not.toContain('PermissionRequest');
  });

  it('any other exit code is a non-blocking error (04 §2.1)', async () => {
    t.userSettings({
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: t.hook('process.exit(1);') }] }],
      },
    });
    const result = await play(SCENARIOS.tools as Scenario);
    const pre = result.fired.find((fire) => fire.event === 'PreToolUse');
    expect(pre).toMatchObject({ decision: 'none', errors: [expect.stringMatching(/exit code 1/)] });
    expect(result.tools.filter((tool) => tool.outcome === 'ran')).toHaveLength(3);
  });

  it('invalid JSON on stdout and a wrong hookEventName are non-blocking errors (04 §2.1)', async () => {
    t.userSettings({
      hooks: {
        PermissionRequest: [
          { hooks: [{ type: 'command', command: t.hook(`process.stdout.write('{not json');`) }] },
          {
            hooks: [
              {
                type: 'command',
                command: t.hook(
                  `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', decision: { behavior: 'allow' } } }));`,
                ),
              },
            ],
          },
        ],
      },
    });
    const result = await play(SCENARIOS.held as Scenario);
    const permission = result.fired.find((fire) => fire.event === 'PermissionRequest');
    expect(permission?.decision).toBe('none');
    expect(permission?.errors).toHaveLength(2);
  });

  it('a timeout is a non-blocking error: the terminal prompt still appears (04 §2.1, D10)', async () => {
    t.userSettings({
      hooks: {
        PermissionRequest: [
          {
            hooks: [
              {
                type: 'command',
                command: t.hook('await new Promise(() => setInterval(() => {}, 1000));'),
                timeout: 0.3,
              },
            ],
          },
        ],
      },
    });
    const result = await play(SCENARIOS.held as Scenario);
    const permission = result.fired.find((fire) => fire.event === 'PermissionRequest');
    expect(permission?.outcomes[0]?.status).toBe('timeout');
    expect(permission?.decision).toBe('none');
    expect(events(result)).toContain('Notification');
  });

  it('onFailure: "block" turns a timeout or crash into a deny (04 §2.1, D10)', async () => {
    t.userSettings({
      hooks: {
        PermissionRequest: [
          {
            hooks: [
              {
                type: 'command',
                command: t.hook('await new Promise(() => setInterval(() => {}, 1000));'),
                timeout: 0.3,
                onFailure: 'block',
              },
            ],
          },
        ],
      },
    });
    const timedOut = await play(SCENARIOS.held as Scenario);
    expect(timedOut.tools[0]).toMatchObject({ outcome: 'denied', decidedBy: 'PermissionRequest' });
    expect(events(timedOut)).not.toContain('Notification');

    t.userSettings({
      hooks: {
        PermissionRequest: [
          {
            hooks: [
              { type: 'command', command: t.hook(`throw new Error('crash');`), onFailure: 'block' },
            ],
          },
        ],
      },
    });
    const crashed = await play(SCENARIOS.held as Scenario);
    expect(crashed.tools[0]).toMatchObject({
      outcome: 'denied',
      reason: expect.stringMatching(/Hook failed/) as unknown,
    });
  });

  it('async hooks run in the background and cannot decide (04 §2.1)', async () => {
    t.userSettings({
      hooks: {
        PermissionRequest: [{ hooks: [{ type: 'command', command: t.hook(ALLOW), async: true }] }],
      },
    });
    const result = await play(SCENARIOS.held as Scenario);
    const permission = result.fired.find((fire) => fire.event === 'PermissionRequest');
    expect(permission?.outcomes[0]?.status).toBe('async');
    expect(permission?.decision).toBe('none');
    expect(result.tools[0]).toMatchObject({ outcome: 'denied', decidedBy: 'terminal' });
    // The session drains async hooks before it exits, so the payload was delivered.
    expect(t.calls()).toHaveLength(1);
  });

  it('matchers: exact name, `A|B` list, regex and `*` on tool_name; non-matching groups do not run (04 §2.1)', async () => {
    const group = (matcher: string) => ({
      matcher,
      hooks: [{ type: 'command', command: t.hook('') }],
    });
    t.userSettings({
      hooks: {
        PreToolUse: [
          group('Read'),
          group('Edit|Write'),
          group('^Ba.h$'),
          group('*'),
          group('Grep'),
        ],
      },
    });
    await play(SCENARIOS.tools as Scenario);
    const byScript = (script: number) =>
      t
        .calls()
        .filter((call) => call.script === script)
        .map((call) => call.input.tool_name);
    expect(byScript(1)).toEqual(['Read']);
    expect(byScript(2)).toEqual(['Edit']);
    expect(byScript(3)).toEqual(['Bash']);
    expect(byScript(4)).toEqual(['Read', 'Edit', 'Bash']);
    expect(byScript(5)).toEqual([]);
  });

  it('matchers test notification_type, source and trigger on their events (04 §2.1)', async () => {
    const group = (matcher: string) => ({
      matcher,
      hooks: [{ type: 'command', command: t.hook('') }],
    });
    t.userSettings({
      hooks: {
        SessionStart: [group('startup'), group('resume')],
        PreCompact: [group('auto'), group('manual')],
        Notification: [group('idle_prompt'), group('permission_prompt')],
      },
    });
    await play(SCENARIOS.stop as Scenario);
    await play(SCENARIOS.held as Scenario);
    const scripts = t
      .calls()
      .map((call) => call.script)
      .sort();
    expect(scripts).toEqual([1, 1, 3, 6]);
  });

  it('AskUserQuestion is answered through PreToolUse with updatedInput.answers (04 §2.3, D11)', async () => {
    const body = `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...input.tool_input, answers: { 'Which framework?': 'Vue' } } } }));`;
    t.userSettings({
      hooks: {
        PreToolUse: [
          {
            matcher: '^AskUserQuestion$',
            hooks: [{ type: 'command', command: t.hook(body), timeout: 1800 }],
          },
        ],
      },
    });
    const result = await play(SCENARIOS.question as Scenario);
    expect(result.answers).toEqual([{ 'Which framework?': 'Vue' }]);
    expect(t.calls()[0]?.input.tool_input).toMatchObject({
      questions: [{ question: 'Which framework?', multiSelect: false }],
    });
    expect(events(result)).not.toContain('PermissionRequest');
  });

  it('PreToolUse precedence is deny > defer > ask > allow across parallel hooks (04 §2.3)', async () => {
    const decide = (decision: string) =>
      t.hook(
        `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: '${decision}', permissionDecisionReason: '${decision}' } }));`,
      );
    t.userSettings({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Read',
            hooks: [
              { type: 'command', command: decide('allow') },
              { type: 'command', command: decide('ask') },
            ],
          },
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: decide('allow') },
              { type: 'command', command: decide('defer') },
              { type: 'command', command: decide('deny') },
            ],
          },
        ],
      },
    });
    const result = await play(SCENARIOS.tools as Scenario);
    const pre = result.fired
      .filter((fire) => fire.event === 'PreToolUse')
      .map((fire) => fire.decision);
    expect(pre).toEqual(['ask', 'none', 'deny']);
    // `ask` forces the permission flow even for a tool a rule would allow.
    expect(events(result).filter((event) => event === 'PermissionRequest')).toHaveLength(2);
    expect(result.tools.find((tool) => tool.toolName === 'Bash')).toMatchObject({
      outcome: 'denied',
      reason: 'deny',
    });
  });

  it('a blocked Stop makes Claude continue and the re-fired Stop has stop_hook_active: true (04 §2.4)', async () => {
    const body = `if (!input.stop_hook_active) process.stdout.write(JSON.stringify({ decision: 'block', reason: 'run the tests first' }));`;
    t.userSettings({ hooks: { Stop: [{ hooks: [{ type: 'command', command: t.hook(body) }] }] } });
    const result = await play(SCENARIOS.stop as Scenario);
    expect(t.calls().map((call) => call.input.stop_hook_active)).toEqual([false, true]);
    expect(readFileSync(result.transcriptPath, 'utf8')).toContain('run the tests first');
  });

  it('SubagentStop and PreCompact carry their documented fields (04 §2.1, §2.4)', async () => {
    const all = { hooks: [{ type: 'command', command: t.hook('') }] };
    t.userSettings({ hooks: { SubagentStop: [all], PreCompact: [all], SessionEnd: [all] } });
    await play(SCENARIOS.stop as Scenario);
    const [subagent, compact, end] = t.calls().map((call) => call.input);
    expect(subagent).toMatchObject({
      hook_event_name: 'SubagentStop',
      agent_type: 'Explore',
      stop_hook_active: false,
    });
    expect(subagent).toHaveProperty('agent_id');
    expect(subagent).toHaveProperty('agent_transcript_path');
    expect(compact).toMatchObject({ hook_event_name: 'PreCompact', trigger: 'auto' });
    expect(end).toMatchObject({ hook_event_name: 'SessionEnd', reason: 'other' });
  });

  it('UserPromptSubmit exit 2 erases the prompt and nothing else runs (04 §2.4)', async () => {
    t.userSettings({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command: t.hook(`process.stderr.write('secret in prompt'); process.exit(2);`),
              },
            ],
          },
        ],
      },
    });
    const result = await play(SCENARIOS.tools as Scenario);
    expect(result.stoppedEarly).toMatch(/secret in prompt/);
    expect(events(result)).toEqual(['SessionStart', 'UserPromptSubmit', 'SessionEnd']);
    expect(readFileSync(result.transcriptPath, 'utf8')).not.toContain('Fix the failing test');
  });

  it('continue: false stops Claude after the hook (04 §2.1)', async () => {
    t.userSettings({
      hooks: {
        PostToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: t.hook(
                  `process.stdout.write(JSON.stringify({ continue: false, stopReason: 'budget' }));`,
                ),
              },
            ],
          },
        ],
      },
    });
    const result = await play(SCENARIOS.tools as Scenario);
    expect(result.stoppedEarly).toBe('budget');
    expect(result.tools).toHaveLength(1);
  });

  it('disableAllHooks turns every hook off (04 §2.5)', async () => {
    t.userSettings({ hooks: { Stop: [{ hooks: [{ type: 'command', command: t.hook('') }] }] } });
    t.projectSettings({ disableAllHooks: true }, true);
    await play(SCENARIOS.stop as Scenario);
    expect(t.calls()).toHaveLength(0);
  });

  it('the transcript is at ~/.claude/projects/<cwd with non-alnum → "-">/<session>.jsonl (04 §2.6)', async () => {
    const result = await play(SCENARIOS.tools as Scenario, {
      sessionId: '11111111-2222-4333-8444-555555555555',
    });
    const dir = t.cwd.replace(/[^A-Za-z0-9]/g, '-');
    expect(result.transcriptPath).toBe(
      join(t.home, '.claude', 'projects', dir, '11111111-2222-4333-8444-555555555555.jsonl'),
    );
    const lines = readFileSync(result.transcriptPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.length).toBeGreaterThan(5);
    expect(lines[0]).toMatchObject({ type: 'user', parentUuid: null, sessionId: result.sessionId });
    expect(lines[1]?.parentUuid).toBe(lines[0]?.uuid);
  });

  it('agents --json reports blocked/waiting "permission prompt" while the hook holds the request (04 §2.8)', async () => {
    const jobs = join(t.home, '.claude', 'jobs');
    const body = `const { readdirSync } = await import('node:fs'); const [file] = readdirSync(${JSON.stringify(jobs)}); appendFileSync(${JSON.stringify(join(t.root, 'roster.json'))}, readFileSync(${JSON.stringify(jobs)} + '/' + file, 'utf8'));`;
    t.userSettings({
      hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: t.hook(body) }] }] },
    });
    await play(SCENARIOS.held as Scenario);
    const during = JSON.parse(readFileSync(join(t.root, 'roster.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(during).toMatchObject({
      state: 'blocked',
      status: 'waiting',
      waitingFor: 'permission prompt',
    });
    expect(readAgentEntries(t.env)[0]).toMatchObject({ state: 'done', status: 'idle' });
    expect(readAgentEntries(t.env)[0]).not.toHaveProperty('waitingFor');
  });

  it('settings problems are warnings, never crashes; non-command hook types are skipped (D11)', async () => {
    t.userSettings('{ broken');
    t.projectSettings({
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'http', command: 'x' },
              { type: 'command', command: t.hook('') },
            ],
          },
        ],
        TaskCreated: [{ hooks: [] }],
      },
    });
    const result = await play(SCENARIOS.stop as Scenario);
    expect(result.warnings.join('\n')).toMatch(
      /invalid JSON[\s\S]*unsupported hook type[\s\S]*TaskCreated/,
    );
    expect(t.calls()).toHaveLength(1);
    expect(existsSync(result.transcriptPath)).toBe(true);
  });
});
