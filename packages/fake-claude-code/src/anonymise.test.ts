import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AnonymiseError,
  FORBIDDEN_PATTERN,
  PLACEHOLDER,
  SYNTHETIC_CWD,
  anonymisePayload,
  assertNoForbidden,
  keySet,
} from './anonymise.js';
import { anonymiseDirectory, anonymiseMain } from './anonymise-dir.js';
import { HOOK_EVENTS } from './events.js';
import { DOCUMENTED_EXAMPLES } from './payloads.js';
import { SCENARIOS, type Scenario } from './scenarios.js';
import { FakeSession } from './session.js';
import { RECORD_HOOK_BIN } from './shim.js';
import { TempEnv } from './test-env.js';
import { seededRandom, steppingClock } from './testing.js';

const META = { claudeCodeVersion: '2.1.300', capturedAt: '2026-10-12T00:00:00.000Z' };

let t: TempEnv;

beforeEach(() => {
  t = new TempEnv();
});

afterEach(() => {
  t.cleanup();
});

const realLooking = {
  session_id: '6f0d2c1e-0b7a-4c55-9d2e-1f3a4b5c6d7e',
  transcript_path: '/Users/ivan/.claude/projects/-Users-ivan-work/6f0d2c1e.jsonl',
  cwd: '/Users/ivan/work',
  permission_mode: 'default',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: {
    command: 'cat /Users/ivan/.ssh/id_ed25519',
    description: 'Read key of ivan.baev@gmail.com',
  },
  permission_suggestions: [
    {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'cat /Users/ivan/.ssh/id_ed25519' }],
      behavior: 'allow',
      destination: 'localSettings',
    },
  ],
};

describe('fixture anonymiser (07 §5.4)', () => {
  it('rewrites paths and IDs, scrubs content, keeps the key set and the enum fields', () => {
    const out = anonymisePayload(realLooking, META);
    expect(keySet(out)).toEqual(keySet(realLooking));
    expect(out).toMatchObject({
      cwd: SYNTHETIC_CWD,
      session_id: '00000000-0000-4000-8000-000000000001',
      tool_name: 'Bash',
      hook_event_name: 'PermissionRequest',
      permission_mode: 'default',
      tool_input: { command: PLACEHOLDER, description: PLACEHOLDER },
      permission_suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: PLACEHOLDER }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ],
      _meta: { claude_code_version: '2.1.300', captured_at: META.capturedAt },
    });
    expect(String(out.transcript_path)).toMatch(/^\/home\/synthetic\//);
    expect(JSON.stringify(out)).not.toMatch(FORBIDDEN_PATTERN);
  });

  it('rejects a payload whose canary path survives in a kept field, naming the path but not the value', () => {
    const canary = { ...realLooking, hook_event_name: 'SessionEnd', reason: '/Users/ivan/canary' };
    let caught: unknown;
    try {
      anonymisePayload(canary, META);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AnonymiseError);
    expect((caught as AnonymiseError).paths).toEqual(['$.reason']);
    expect((caught as AnonymiseError).message).not.toContain('canary');
  });

  it('rejects a canary in an enum-like value and in a key, and renames content keys', () => {
    expect(() =>
      anonymisePayload({ ...realLooking, tool_input: { type: 'ivan_tool' } }, META),
    ).toThrow(AnonymiseError);
    expect(() => assertNoForbidden({ nested: [{ 'C:\\Users\\x': 1 }] })).toThrow(
      /\$\.nested\[0\]\{key\}/,
    );
    const out = anonymisePayload(
      {
        hook_event_name: 'PreToolUse',
        tool_input: { answers: { 'Which framework?': 'Vue' } },
        n: 3,
        _meta: { old: true },
      },
      META,
    );
    expect(out.tool_input).toEqual({ answers: { key_1: PLACEHOLDER } });
    expect(out.n).toBe(3);
    expect(out._meta).toEqual({ claude_code_version: '2.1.300', captured_at: META.capturedAt });
    expect(FORBIDDEN_PATTERN.test('/home/synthetic/project')).toBe(false);
    expect(FORBIDDEN_PATTERN.test('/home/someone/project')).toBe(true);
  });

  it('the documented examples anonymise cleanly', () => {
    for (const example of Object.values(DOCUMENTED_EXAMPLES)) {
      expect(keySet(anonymisePayload(example, META))).toEqual(keySet(example));
    }
  });

  it('record-hook saves every payload; fixtures:anonymise writes clean fixtures and a key-set snapshot', async () => {
    const raw = join(t.root, 'raw');
    const command = `"${process.execPath}" "${RECORD_HOOK_BIN}" "${raw}"`;
    const hooks = Object.fromEntries(
      HOOK_EVENTS.map((event) => [event, [{ hooks: [{ type: 'command', command }] }]]),
    );
    t.userSettings({ hooks });
    for (const name of Object.keys(SCENARIOS)) {
      await new FakeSession({
        env: t.env,
        cwd: t.cwd,
        clock: steppingClock(),
        random: seededRandom(11),
        scenario: SCENARIOS[name] as Scenario,
      }).run();
    }
    expect(new Set(readdirSync(raw).map((file) => file.replace(/-\d+\.json$/, '')))).toEqual(
      new Set(HOOK_EVENTS),
    );

    const out = join(t.root, 'out');
    const lines: string[] = [];
    const io = {
      stdout: (text: string) => lines.push(text),
      stderr: (text: string) => lines.push(text),
    };
    expect(anonymiseMain([raw, out, '--claude-version', '2.1.300'], io)).toBe(0);
    for (const file of readdirSync(out)) {
      expect(readFileSync(join(out, file), 'utf8')).not.toMatch(FORBIDDEN_PATTERN);
    }
    // The fake's payload shapes, pinned. M0-23 compares real recordings against this file.
    // Compared as parsed JSON, so prettier may reformat the committed fixture.
    const pinned = fileURLToPath(new URL('../fixtures/key-sets.json', import.meta.url));
    expect(JSON.parse(readFileSync(join(out, 'key-sets.json'), 'utf8'))).toEqual(
      JSON.parse(readFileSync(pinned, 'utf8')),
    );
  });

  it('fixtures:anonymise refuses the whole batch when one recording leaks, and checks its usage', () => {
    const raw = join(t.root, 'raw');
    mkdirSync(raw);
    writeFileSync(
      join(raw, 'Stop-0000.json'),
      JSON.stringify({ hook_event_name: 'Stop', session_id: 'x' }),
    );
    writeFileSync(
      join(raw, 'SessionEnd-0001.json'),
      JSON.stringify({ hook_event_name: 'SessionEnd', reason: 'C:\\Users\\canary' }),
    );
    const out = join(t.root, 'out');
    expect(() =>
      anonymiseDirectory({ rawDir: raw, outDir: out, claudeCodeVersion: '2.1.300' }),
    ).toThrow(/SessionEnd-0001\.json: .*\$\.reason/);
    const lines: string[] = [];
    const io = {
      stdout: (text: string) => lines.push(text),
      stderr: (text: string) => lines.push(text),
    };
    expect(anonymiseMain([raw, out, '--claude-version', '2.1.300'], io)).toBe(1);
    expect(anonymiseMain([raw], io)).toBe(2);
    expect(() => readdirSync(out)).toThrow();
  });

  it('record-hook never fails, even on garbage input', () => {
    const result = spawnSync(process.execPath, [RECORD_HOOK_BIN, join(t.root, 'raw')], {
      input: 'not json',
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
});
