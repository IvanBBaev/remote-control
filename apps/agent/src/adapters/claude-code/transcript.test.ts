import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FORBIDDEN_PATTERN } from '@remote-control/fake-claude-code';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fileSize, readRange } from '../log-files.js';
import { nodePaths } from '../node-file-system.js';
import { createTranscriptTailer, parseTranscript } from './transcript.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'transcripts');
const posixOnly = process.platform === 'win32' ? it.skip : it;

// Small builders for transcript lines (07 W5): only the fields the parser reads.
let counter = 0;
const id = () => `u-${(counter += 1)}`;
function user(content: unknown, extra: Record<string, unknown> = {}) {
  return {
    type: 'user',
    uuid: id(),
    cwd: '/home/synthetic/repo',
    message: { role: 'user', content },
    ...extra,
  };
}
function assistant(parts: {
  text?: string;
  toolUse?: { id: string; name: string; input: unknown };
}) {
  const content: unknown[] = [];
  if (parts.text !== undefined) content.push({ type: 'text', text: parts.text });
  if (parts.toolUse !== undefined) content.push({ type: 'tool_use', ...parts.toolUse });
  return { type: 'assistant', uuid: id(), message: { role: 'assistant', content } };
}
function toolResult(toolUseId: string, content: unknown = 'ok') {
  return user([{ type: 'tool_result', tool_use_id: toolUseId, content }]);
}
const jsonl = (...lines: unknown[]) =>
  lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n');
const names = (body: string) => parseTranscript(body).entries.map((e) => e.hook_event_name);

describe('parseTranscript (04 W11)', () => {
  const expected: Record<string, string[]> = {
    'agent-outcome-errors': ['UserPromptSubmit', 'PostToolUse', 'PostToolUse'],
    'concurrent-instance-a': ['UserPromptSubmit', 'PostToolUse', 'Stop'],
    'concurrent-instance-b': ['UserPromptSubmit', 'PostToolUse', 'Stop'],
    'crashed-no-stop': ['UserPromptSubmit'],
    'depth-2-sync': ['UserPromptSubmit'],
    'flat-tool-use': ['UserPromptSubmit'],
    'legacy-bare-explore': ['UserPromptSubmit', 'Stop'],
    'nested-workflow': ['UserPromptSubmit'],
    'queue-operation': ['UserPromptSubmit'],
    'task-notification-recovery': ['PreCompact'],
  };

  it('copies every fixture and keeps them synthetic (07 §5.4)', async () => {
    const files = (await readdir(FIXTURES)).filter((name) => name.endsWith('.jsonl'));
    expect(files.map((name) => name.slice(0, -'.jsonl'.length)).sort()).toEqual(
      Object.keys(expected).sort(),
    );
    for (const name of files) {
      expect(FORBIDDEN_PATTERN.test(await readFile(join(FIXTURES, name), 'utf8')), name).toBe(
        false,
      );
    }
  });

  it.each(Object.entries(expected))('parses the %s fixture', async (fixture, events) => {
    const parsed = parseTranscript(await readFile(join(FIXTURES, `${fixture}.jsonl`), 'utf8'));
    expect(parsed.malformed).toBe(0);
    expect(parsed.entries.map((e) => e.hook_event_name)).toEqual(events);
  });

  it('reports a finished tool call with its input, response and cwd', async () => {
    const body = await readFile(join(FIXTURES, 'concurrent-instance-a.jsonl'), 'utf8');
    const [prompt, tool, stop] = parseTranscript(body).entries;
    expect(prompt).toMatchObject({ prompt: expect.any(String) as unknown });
    expect(tool).toMatchObject({
      tool_name: 'Agent',
      tool_input: expect.any(Object) as unknown,
      tool_response: expect.any(String) as unknown,
      cwd: expect.any(String) as unknown,
    });
    expect(stop).toMatchObject({ last_assistant_message: expect.any(String) as unknown });
  });

  it('ends a turn at the next prompt with the last assistant text', () => {
    const body = jsonl(
      user('first'),
      assistant({
        text: 'reading',
        toolUse: { id: 't1', name: 'Read', input: { file_path: 'a.ts' } },
      }),
      toolResult('t1', [{ type: 'text', text: 'contents' }]),
      assistant({ text: 'done' }),
      user([{ type: 'text', text: 'second' }]),
    );
    expect(parseTranscript(body).entries).toEqual([
      { hook_event_name: 'UserPromptSubmit', prompt: 'first' },
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: { file_path: 'a.ts' },
        tool_response: 'contents',
        cwd: '/home/synthetic/repo',
      },
      { hook_event_name: 'Stop', last_assistant_message: 'done' },
      { hook_event_name: 'UserPromptSubmit', prompt: 'second' },
    ]);
  });

  it('ends a turn with no assistant text without a message', () => {
    expect(parseTranscript(jsonl(user('one'), user('two'))).entries).toEqual([
      { hook_event_name: 'UserPromptSubmit', prompt: 'one' },
      { hook_event_name: 'Stop' },
      { hook_event_name: 'UserPromptSubmit', prompt: 'two' },
    ]);
  });

  it('ends the last turn at the end when it settled on assistant text', () => {
    expect(names(jsonl(user('go'), assistant({ text: 'all done' })))).toEqual([
      'UserPromptSubmit',
      'Stop',
    ]);
  });

  it('leaves the last turn open while a tool call is running or after a result', () => {
    const running = jsonl(
      user('go'),
      assistant({ text: 'running', toolUse: { id: 't1', name: 'Bash', input: {} } }),
    );
    expect(names(running)).toEqual(['UserPromptSubmit']);
    const afterResult = jsonl(
      user('go'),
      assistant({ toolUse: { id: 't1', name: 'Bash', input: {} } }),
      toolResult('t1'),
    );
    expect(names(afterResult)).toEqual(['UserPromptSubmit', 'PostToolUse']);
  });

  it('skips compaction summaries but reports the compaction', () => {
    const boundary = { type: 'system', subtype: 'compact_boundary', uuid: 'b-1' };
    const body = jsonl(
      user('go'),
      boundary,
      user('Summary of the conversation so far', { parentUuid: 'b-1' }),
      user('flagged summary', { isCompactSummary: true }),
      { type: 'system', subtype: 'informational' },
    );
    expect(names(body)).toEqual(['UserPromptSubmit', 'PreCompact']);
    expect(names(jsonl({ type: 'system', subtype: 'compact_boundary' }))).toEqual(['PreCompact']);
  });

  it('skips subagent, meta, wrapped and blank user lines and unknown types', () => {
    const body = jsonl(
      user('subagent prompt', { isSidechain: true }),
      user('caveat', { isMeta: true }),
      user('<command-name>/clear</command-name>'),
      user('  '),
      user(42),
      { type: 'summary', summary: 'x' },
      { type: 'progress' },
      { type: 'assistant' },
      { type: 'user' },
    );
    expect(parseTranscript(body)).toEqual({ entries: [], malformed: 0 });
  });

  it('skips tool results without a known call and tool uses without an id or name', () => {
    const body = jsonl(
      user('go'),
      assistant({ toolUse: { id: 't1', name: 'Bash', input: {} } }),
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'NoId' }, 'junk'] } },
      toolResult('orphan'),
      user([{ type: 'tool_result' }]),
    );
    expect(names(body)).toEqual(['UserPromptSubmit']);
  });

  it('defaults a missing tool input to null and omits an unknown cwd', () => {
    const body = jsonl(
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
    );
    expect(parseTranscript(body).entries).toEqual([
      { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: null, tool_response: '' },
    ]);
  });

  it('counts malformed lines without throwing', () => {
    const body = jsonl('garbage', 'null', '[]', '"str"', '42', '{"type":"user"', user('kept'), '');
    const parsed = parseTranscript(body);
    expect(parsed.malformed).toBe(6);
    expect(parsed.entries).toEqual([{ hook_event_name: 'UserPromptSubmit', prompt: 'kept' }]);
  });
});

describe('createTranscriptTailer (04 W11)', () => {
  let base: string;
  let claudeConfigDir: string;
  let project: string;
  let logs: { event: string; fields: Readonly<Record<string, unknown>> }[];

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'remotectl-transcript-'));
    claudeConfigDir = join(base, 'claude');
    project = join(claudeConfigDir, 'projects', '-home-synthetic-repo');
    await mkdir(project, { recursive: true });
    logs = [];
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  function tailer(overrides: Partial<Parameters<typeof createTranscriptTailer>[0]> = {}) {
    return createTranscriptTailer({
      claudeConfigDir,
      paths: nodePaths,
      size: fileSize,
      read: readRange,
      log: (event, fields) => logs.push({ event, fields }),
      ...overrides,
    });
  }
  async function transcript(name: string, body: string) {
    const path = join(project, name);
    await writeFile(path, body);
    return path;
  }

  it('reads a transcript inside the projects folder', async () => {
    const path = await transcript('s1.jsonl', jsonl(user('go'), assistant({ text: 'done' })));
    expect((await tailer().history(path)).map((e) => e.hook_event_name)).toEqual([
      'UserPromptSubmit',
      'Stop',
    ]);
    expect(logs).toEqual([
      {
        event: 'transcript_read',
        fields: {
          bytes: expect.any(Number) as unknown,
          entries: 2,
          malformed: 0,
          truncated: false,
        },
      },
    ]);
  });

  it('skips a path that is relative, not .jsonl, missing or outside the projects folder', async () => {
    const outside = join(base, 'outside.jsonl');
    await writeFile(outside, jsonl(user('secret')));
    const notJsonl = await transcript('s1.json', jsonl(user('go')));
    for (const path of [
      'projects/s1.jsonl',
      notJsonl,
      join(project, 'missing.jsonl'),
      outside,
      join(project, '..', '..', '..', 'outside.jsonl'),
    ]) {
      expect(await tailer().history(path), path).toEqual([]);
    }
    expect(logs.every((entry) => entry.event === 'transcript_skipped')).toBe(true);
    expect(logs).toHaveLength(5);
  });

  posixOnly('skips a symlink that leads out of the projects folder', async () => {
    const outside = join(base, 'outside.jsonl');
    await writeFile(outside, jsonl(user('secret')));
    const link = join(project, 'link.jsonl');
    await symlink(outside, link);
    expect(await tailer().history(link)).toEqual([]);
    expect(logs).toEqual([{ event: 'transcript_skipped', fields: { reason: 'path' } }]);
  });

  it('skips everything when the projects folder does not exist', async () => {
    const path = await transcript('s1.jsonl', jsonl(user('go')));
    expect(await tailer({ claudeConfigDir: join(base, 'none') }).history(path)).toEqual([]);
    expect(logs[0]?.event).toBe('transcript_skipped');
  });

  it('reads only the tail and drops its cut first line', async () => {
    const first = JSON.stringify(user('a long first prompt that will be cut in half'));
    const second = JSON.stringify(user('kept'));
    const path = await transcript('s1.jsonl', `${first}\n${second}\n`);
    const entries = await tailer({ maxBytes: second.length + 10 }).history(path);
    expect(entries).toEqual([{ hook_event_name: 'UserPromptSubmit', prompt: 'kept' }]);
    expect(logs[0]?.fields).toMatchObject({ entries: 1, malformed: 0, truncated: true });
  });

  it('yields nothing when the tail holds no whole line', async () => {
    const path = await transcript('s1.jsonl', JSON.stringify(user('one very long line')));
    expect(await tailer({ maxBytes: 8 }).history(path)).toEqual([]);
    expect(logs[0]?.fields).toMatchObject({ entries: 0, truncated: true });
  });

  it('never rejects when reading fails', async () => {
    const path = await transcript('s1.jsonl', jsonl(user('go')));
    const failing = tailer({
      read: () => Promise.reject(Object.assign(new Error('boom'), { code: 'EIO' })),
    });
    expect(await failing.history(path)).toEqual([]);
    const thrown = tailer({ size: () => Promise.reject(new Error('no code')) });
    expect(await thrown.history(path)).toEqual([]);
    expect(logs).toEqual([
      { event: 'transcript_failed', fields: { code: 'EIO' } },
      { event: 'transcript_failed', fields: { code: null } },
    ]);
  });
});
