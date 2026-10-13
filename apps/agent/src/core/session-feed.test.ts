import { MAX_SESSION_STEPS } from '@remote-control/protocol';
import { describe, expect, it } from 'vitest';

import type { HookInput } from './hook-dispatcher.js';
import {
  changedFile,
  createSessionFeed,
  lineCounts,
  mapHookEvent,
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
