import { MAX_SESSION_STEPS, type FeedEvent } from '@remote-control/protocol';
import { describe, expect, it } from 'vitest';

import type { TranscriptEntry } from '../ports/transcript-tailer.js';
import type { HookInput } from './hook-dispatcher.js';
import {
  changedFile,
  createSessionFeed,
  lineCounts,
  mapHookEvent,
  mergeHistory,
  MAX_FEED_SESSIONS,
} from './session-feed.js';

const CWD = '/home/synthetic/project';

function hook(
  event: string,
  fields: Record<string, unknown> = {},
  sessionId = 'abc123',
): HookInput {
  return {
    session_id: sessionId,
    transcript_path: '/home/synthetic/.claude/projects/-home-synthetic-project/abc123.jsonl',
    cwd: CWD,
    permission_mode: 'default',
    hook_event_name: event,
    ...fields,
  };
}

function postToolUse(toolName: string, toolInput: unknown, toolResponse: unknown): HookInput {
  return hook('PostToolUse', {
    prompt_id: 'prompt_01',
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: toolResponse,
    tool_use_id: 'toolu_01',
    duration_ms: 12,
  });
}

describe('mapHookEvent (golden, 04 §2.4)', () => {
  it('UserPromptSubmit → prompt', () => {
    expect(mapHookEvent(hook('UserPromptSubmit', { prompt: 'Fix the build' }))).toEqual({
      kind: 'prompt',
      text: 'Fix the build',
    });
    expect(mapHookEvent(hook('UserPromptSubmit'))).toEqual({ kind: 'prompt', text: '' });
    const long = mapHookEvent(hook('UserPromptSubmit', { prompt: 'p'.repeat(5000) }));
    expect(long).toEqual({ kind: 'prompt', text: `${'p'.repeat(3999)}…` });
  });

  it('PostToolUse Bash → the command and its output', () => {
    expect(
      mapHookEvent(
        postToolUse(
          'Bash',
          { command: 'npm test', description: 'Run tests' },
          { stdout: '3 passed', stderr: '', interrupted: false, isImage: false },
        ),
      ),
    ).toEqual({
      kind: 'tool',
      tool: 'Bash',
      label: 'Run a command',
      input: 'npm test',
      response: '3 passed',
      truncated: false,
    });
    expect(
      mapHookEvent(postToolUse('Bash', { command: 'make' }, { stdout: 'out', stderr: 'warn' })),
    ).toMatchObject({ response: 'out\nwarn' });
  });

  it('PostToolUse Edit → the file inside the folder, +N −M, no response body (D21)', () => {
    expect(
      mapHookEvent(
        postToolUse(
          'Edit',
          {
            file_path: `${CWD}/src/a.ts`,
            old_string: 'const a = 1;\nconst b = 2;\nexport { a };',
            new_string: 'const a = 1;\nconst b = 3;\nconst c = 4;\nexport { a };',
          },
          { filePath: `${CWD}/src/a.ts`, originalFile: 'SECRET FILE BODY', structuredPatch: [] },
        ),
      ),
    ).toEqual({
      kind: 'tool',
      tool: 'Edit',
      label: 'Edit a file',
      input: 'src/a.ts',
      response: '',
      truncated: false,
      file: { name: `${CWD}/src/a.ts`, added: 2, removed: 1 },
    });
  });

  it('PostToolUse Write and MultiEdit → line counts from tool_input', () => {
    expect(
      mapHookEvent(
        postToolUse('Write', { file_path: '/elsewhere/b.md', content: 'a\nb\nc\n' }, {}),
      ),
    ).toMatchObject({ input: 'b.md', file: { name: '/elsewhere/b.md', added: 3, removed: 0 } });
    expect(
      mapHookEvent(
        postToolUse(
          'MultiEdit',
          {
            file_path: `${CWD}/c.ts`,
            edits: [
              { old_string: 'x', new_string: 'y' },
              { old_string: 'a\nb', new_string: 'a' },
              'not an edit',
            ],
          },
          {},
        ),
      ),
    ).toMatchObject({ file: { name: `${CWD}/c.ts`, added: 1, removed: 2 } });
  });

  it('PostToolUse other tools → the input and the response as text', () => {
    expect(
      mapHookEvent(postToolUse('WebFetch', { url: 'https://example.com' }, 'Fetched')),
    ).toEqual({
      kind: 'tool',
      tool: 'WebFetch',
      label: expect.any(String) as unknown,
      input: 'https://example.com',
      response: 'Fetched',
      truncated: false,
    });
    expect(
      mapHookEvent(postToolUse('mcp__github__create_issue', { title: 't' }, { id: 7 })),
    ).toMatchObject({ input: '{"title":"t"}', response: '{"id":7}' });
    expect(mapHookEvent(postToolUse('Bash', { command: 'true' }, null))).toMatchObject({
      response: '',
    });
    expect(
      mapHookEvent(postToolUse('Bash', { command: 'cat' }, { stdout: 'o'.repeat(3000) })),
    ).toMatchObject({ truncated: true, response: `${'o'.repeat(1999)}…` });
    expect(mapHookEvent(postToolUse('Bash', { command: 'c'.repeat(3000) }, ''))).toMatchObject({
      truncated: true,
    });
  });

  it('PostToolUse without a tool name → nothing', () => {
    expect(mapHookEvent(hook('PostToolUse', { tool_input: {} }))).toBeUndefined();
    expect(mapHookEvent(hook('PostToolUse', { tool_name: '' }))).toBeUndefined();
  });

  it('Stop → the last assistant message', () => {
    expect(
      mapHookEvent(
        hook('Stop', {
          stop_hook_active: false,
          last_assistant_message: 'The test passes now.',
          background_tasks: [],
          session_crons: [],
        }),
      ),
    ).toEqual({ kind: 'stop', text: 'The test passes now.' });
    expect(mapHookEvent(hook('Stop'))).toEqual({ kind: 'stop', text: null });
  });

  it('SubagentStop, PreCompact, Notification → steps', () => {
    expect(mapHookEvent(hook('SubagentStop', { agent_id: 'a1', agent_type: 'Explore' }))).toEqual({
      kind: 'subagent_stop',
    });
    expect(mapHookEvent(hook('PreCompact', { trigger: 'auto', custom_instructions: '' }))).toEqual({
      kind: 'compact',
    });
    expect(
      mapHookEvent(
        hook('Notification', {
          message: 'Claude is waiting for your input',
          title: 'Claude Code',
          notification_type: 'idle_prompt',
        }),
      ),
    ).toEqual({ kind: 'notification', text: 'Claude is waiting for your input' });
    expect(mapHookEvent(hook('Notification', { message: '  ' }))).toEqual({
      kind: 'notification',
      text: 'Notification',
    });
  });

  it('other events → nothing', () => {
    for (const event of ['SessionStart', 'SessionEnd', 'PreToolUse', 'PermissionRequest']) {
      expect(mapHookEvent(hook(event))).toBeUndefined();
    }
  });
});

describe('lineCounts and changedFile', () => {
  it('counts the lines between the common ends', () => {
    expect(lineCounts('a\nb\nc', 'a\nb\nc')).toEqual({ added: 0, removed: 0 });
    expect(lineCounts('', 'a\nb\n')).toEqual({ added: 2, removed: 0 });
    expect(lineCounts('a\nb', undefined)).toEqual({ added: 0, removed: 2 });
    expect(lineCounts('a\nx\na', 'a\na')).toEqual({ added: 0, removed: 1 });
  });

  it('only for file edits with a usable path', () => {
    expect(changedFile('Read', { file_path: '/a' })).toBeUndefined();
    expect(changedFile('Edit', { file_path: '' })).toBeUndefined();
    expect(changedFile('Edit', { file_path: 'x'.repeat(4097) })).toBeUndefined();
    expect(changedFile('MultiEdit', { file_path: '/a', edits: 'no' })).toBeUndefined();
    expect(changedFile('Edit', null)).toBeUndefined();
  });
});

describe('createSessionFeed', () => {
  it('applies events per session with a sequence number', () => {
    const feed = createSessionFeed();
    expect(feed.observe(hook('SessionStart'))).toBeUndefined();
    expect(feed.get('abc123')).toBeUndefined();
    expect(feed.observe(hook('UserPromptSubmit', { prompt: 'Go' }))).toEqual({
      event: { kind: 'prompt', text: 'Go' },
      seq: 1,
    });
    feed.observe(
      postToolUse('Edit', { file_path: `${CWD}/a.ts`, old_string: 'a', new_string: 'b' }, {}),
    );
    feed.observe(hook('Stop', { last_assistant_message: 'Done' }));
    expect(feed.get('abc123')).toEqual({
      seq: 3,
      content: {
        lastPrompt: 'Go',
        lastAnswer: 'Done',
        steps: ['Edit a file: a.ts'],
        changedFiles: [{ name: `${CWD}/a.ts`, added: 1, removed: 1 }],
      },
    });
    expect(feed.get('other')).toBeUndefined();
  });

  it('keeps 20 steps per session and forgets the least recently updated session', () => {
    const feed = createSessionFeed();
    for (let i = 0; i < 30; i += 1) feed.observe(hook('PreCompact'));
    expect(feed.get('abc123')!.content.steps).toHaveLength(MAX_SESSION_STEPS);
    for (let i = 0; i < MAX_FEED_SESSIONS; i += 1) feed.observe(hook('PreCompact', {}, `s${i}`));
    expect(feed.get('abc123')).toBeUndefined();
    expect(feed.get('s0')).toBeDefined();
  });
});

describe('mergeHistory (04 W11)', () => {
  const prompt = (text: string): FeedEvent => ({ kind: 'prompt', text });
  const tool = (input: string): FeedEvent => ({
    kind: 'tool',
    tool: 'Bash',
    label: 'Run a command',
    input,
    response: '',
    truncated: false,
  });
  const stop: FeedEvent = { kind: 'stop', text: 'Done' };

  it('places the live events where they continue the history', () => {
    // The history's tail is the live head.
    expect(mergeHistory([prompt('a'), tool('x'), tool('y')], [tool('x'), tool('y'), stop])).toEqual(
      { events: [prompt('a'), tool('x'), tool('y'), stop], ahead: [] },
    );
    // The history runs past the live events: those history events are ahead.
    expect(mergeHistory([prompt('a'), tool('x'), tool('y')], [tool('x')])).toEqual({
      events: [prompt('a'), tool('x'), tool('y')],
      ahead: [tool('y')],
    });
    // The latest place wins.
    expect(mergeHistory([tool('x'), prompt('b'), tool('x')], [tool('x')])).toEqual({
      events: [tool('x'), prompt('b'), tool('x')],
      ahead: [],
    });
  });

  it('appends the live events when they do not continue the history', () => {
    expect(mergeHistory([prompt('a'), tool('x')], [tool('y')])).toEqual({
      events: [prompt('a'), tool('x'), tool('y')],
      ahead: [],
    });
    expect(mergeHistory([stop], [{ kind: 'stop', text: 'other' }]).events).toHaveLength(1);
    expect(mergeHistory([], [prompt('a')])).toEqual({ events: [prompt('a')], ahead: [] });
    expect(mergeHistory([prompt('a')], [])).toEqual({ events: [prompt('a')], ahead: [] });
  });
});

describe('SessionFeed backfill (04 W11)', () => {
  const history: TranscriptEntry[] = [
    { hook_event_name: 'UserPromptSubmit', prompt: 'Earlier' },
    { hook_event_name: 'Stop', last_assistant_message: 'Earlier answer' },
    { hook_event_name: 'UserPromptSubmit', prompt: 'Go' },
    { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
    { hook_event_name: 'SessionStart' },
  ];

  it('starts once, for a session the feed has not seen', () => {
    const feed = createSessionFeed();
    feed.observe(hook('PreCompact', {}, 'known'));
    expect(feed.startBackfill('known')).toBe(false);
    expect(feed.startBackfill('abc123')).toBe(true);
    expect(feed.startBackfill('abc123')).toBe(false);
  });

  it('rebuilds the session from history and the live events, without duplicates', () => {
    const feed = createSessionFeed();
    expect(feed.startBackfill('abc123')).toBe(true);
    feed.observe(postToolUse('Bash', { command: 'ls' }, { stdout: 'a' }));
    feed.observe(hook('Stop', { last_assistant_message: 'Done' }));
    expect(feed.get('abc123')!.seq).toBe(2);
    const entry = feed.backfill('abc123', history);
    expect(entry).toEqual(feed.get('abc123'));
    expect(entry).toMatchObject({
      seq: 3,
      content: { lastPrompt: 'Go', lastAnswer: 'Done', steps: [expect.any(String) as unknown] },
    });
    // The backfill is over: later events fold on top and no longer buffer.
    expect(feed.observe(hook('UserPromptSubmit', { prompt: 'Next' }))?.seq).toBe(4);
    expect(feed.startBackfill('abc123')).toBe(false);
  });

  it('skips the live events the history already showed', () => {
    const feed = createSessionFeed();
    feed.startBackfill('abc123');
    feed.observe(hook('UserPromptSubmit', { prompt: 'Go' }));
    const ahead: TranscriptEntry[] = [
      { hook_event_name: 'UserPromptSubmit', prompt: 'Go' },
      { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
      { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'pwd' } },
    ];
    expect(feed.backfill('abc123', ahead)?.content.steps).toHaveLength(2);
    expect(feed.observe(postToolUse('Bash', { command: 'ls' }, {}))).toBeUndefined();
    expect(feed.observe(postToolUse('Bash', { command: 'pwd' }, {}))).toBeUndefined();
    expect(feed.observe(postToolUse('Bash', { command: 'pwd' }, {}))?.seq).toBe(3);
    expect(feed.get('abc123')!.content.steps).toHaveLength(3);
  });

  it('stops skipping at the first live event the history did not show', () => {
    const feed = createSessionFeed();
    feed.startBackfill('abc123');
    feed.observe(hook('UserPromptSubmit', { prompt: 'Go' }));
    feed.backfill('abc123', [
      { hook_event_name: 'UserPromptSubmit', prompt: 'Go' },
      { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
    ]);
    expect(feed.observe(hook('Stop', { last_assistant_message: 'Done' }))?.seq).toBe(3);
    expect(feed.observe(postToolUse('Bash', { command: 'ls' }, {}))?.seq).toBe(4);
  });

  it('builds a session from history alone when nothing live is mapped yet', () => {
    const feed = createSessionFeed();
    feed.startBackfill('abc123');
    expect(feed.backfill('abc123', history.slice(0, 2))).toEqual({
      seq: 1,
      content: { lastPrompt: 'Earlier', lastAnswer: 'Earlier answer', steps: [], changedFiles: [] },
    });
  });

  it('changes nothing when the history adds nothing', () => {
    const feed = createSessionFeed();
    feed.startBackfill('abc123');
    feed.observe(hook('UserPromptSubmit', { prompt: 'Go' }));
    expect(feed.backfill('abc123', [{ hook_event_name: 'UserPromptSubmit', prompt: 'Go' }])).toBe(
      undefined,
    );
    // Not started (or already over): the session is left as it is.
    expect(feed.backfill('abc123', history)).toBeUndefined();
    expect(feed.backfill('other', history)).toBeUndefined();
    feed.startBackfill('empty');
    expect(feed.backfill('empty', [{ hook_event_name: 'SessionStart' }])).toBeUndefined();
    expect(feed.get('abc123')!.seq).toBe(1);
    expect(feed.get('other')).toBeUndefined();
    expect(feed.get('empty')).toBeUndefined();
  });
});
