import { describe, expect, it } from 'vitest';

import {
  claudeCommand,
  DEFAULT_HOLD_SECONDS,
  DEFAULT_RUNS,
  HOLD_HOOK_TIMEOUT_SECONDS,
  holdSettings,
  hookCommand,
  main,
  overheadReport,
  parseOptions,
  percentile,
  permissionAnswer,
  postToolUseInput,
  timings,
} from './verify-claude-code.js';

describe('parseOptions', () => {
  it('reads the overhead and hold commands with their defaults', () => {
    expect(parseOptions(['overhead'])).toEqual({ command: 'overhead', runs: DEFAULT_RUNS });
    expect(parseOptions(['overhead', '--runs', '50'])).toEqual({ command: 'overhead', runs: 50 });
    expect(parseOptions(['hold'])).toEqual({
      command: 'hold',
      holdSeconds: DEFAULT_HOLD_SECONDS,
      decision: 'allow',
    });
    expect(parseOptions(['hold', '--hold-seconds', '30', '--decision', 'deny'])).toEqual({
      command: 'hold',
      holdSeconds: 30,
      decision: 'deny',
    });
  });

  it.each([
    [[]],
    [['run']],
    [['overhead', '--runs']],
    [['overhead', '--runs', '0']],
    [['overhead', '--runs', '1.5']],
    [['overhead', '--hold-seconds', '5']],
    [['overhead', 'runs', '5']],
    [['overhead', '--runs', '5', '--runs', '6']],
    [['hold', '--hold-seconds', '-1']],
    [['hold', '--decision', 'ask']],
    [['hold', '--runs', '5']],
  ])('rejects %j', (argv) => {
    expect(parseOptions(argv)).toBeUndefined();
  });
});

describe('timings', () => {
  it('takes nearest-rank percentiles', () => {
    const values = Array.from({ length: 100 }, (_, i) => 100 - i);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([3, 1, 2], 0)).toBe(1);
    expect(percentile([], 95)).toBe(0);
    expect(timings([30, 10, 20])).toEqual({ runs: 3, p50: 20, p95: 30, max: 30 });
    expect(timings([])).toEqual({ runs: 0, p50: 0, p95: 0, max: 0 });
  });

  it('judges the hook p95 against the 150 ms target (04 W12)', () => {
    const node = { runs: 2, p50: 20, p95: 25, max: 30 };
    expect(overheadReport({ runs: 2, p50: 40, p95: 149.9, max: 160 }, node)).toContain(
      'hook p95 149.9 ms vs target < 150 ms: PASS',
    );
    expect(overheadReport({ runs: 2, p50: 40, p95: 150, max: 160 }, node)).toMatch(/: FAIL$/);
  });
});

describe('hook wiring', () => {
  it('installs only the blocking hook, with the 30 min timeout, in the installer shape', () => {
    const command = hookCommand('/usr/bin/node', '/tmp/d/hook.cjs', HOLD_HOOK_TIMEOUT_SECONDS);
    expect(command).toBe('"/usr/bin/node" "/tmp/d/hook.cjs" 1800');
    expect(holdSettings(command)).toEqual({
      hooks: {
        PermissionRequest: [{ hooks: [{ type: 'command', command, timeout: 1800 }] }],
      },
    });
  });

  it('runs Claude Code without the user-level settings, interactive or in the background', () => {
    expect(claudeCommand('/tmp/r')).toBe(
      `cd '/tmp/r' && claude --setting-sources project,local "Run exactly this shell command and nothing else: touch rc-verified.txt"`,
    );
    expect(claudeCommand('/tmp/r', true)).toMatch(
      /&& claude --bg --setting-sources project,local /,
    );
  });

  it('answers in the PermissionRequest shape of 04 §2.2', () => {
    expect(permissionAnswer('allow')).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(permissionAnswer('deny')).toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'deny', interrupt: false } },
    });
    expect(JSON.parse(postToolUseInput(3))).toMatchObject({
      hook_event_name: 'PostToolUse',
      tool_input: { command: 'echo 3' },
    });
  });

  it('prints the usage for bad arguments', async () => {
    expect(await main(['nope'])).toBe(2);
  });
});
