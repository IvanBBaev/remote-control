import {
  DiffMessage,
  MAX_CHANGED_FILES,
  MAX_DIFF_LENGTH,
  MAX_DIFF_LINES,
  MAX_MESSAGE_BYTES,
  messageBytes,
} from '@remote-control/protocol';
import { describe, expect, it } from 'vitest';

import {
  createDiffStore,
  diffMessage,
  fileHunks,
  fitPatch,
  MAX_DIFF_LINE_LENGTH,
  type Hunk,
} from './diff-store.js';
import type { HookInput } from './hook-dispatcher.js';

const SESSION = '5b7c1e2a-9d3f-4e8a-b6c4-2f1d0e9a8b7c';
const REQUEST = { t: 'diff_request', requestId: '0190a5b2-1c3d-7e4f-8a9b-0c1d2e3f4a5b' } as const;

function post(tool: string, input: unknown, response: unknown = {}, session = SESSION): HookInput {
  return {
    hook_event_name: 'PostToolUse',
    session_id: session,
    cwd: '/work',
    tool_name: tool,
    tool_input: input,
    tool_response: response,
  };
}

function hunk(lines: number, start = 1, width = 1): Hunk {
  return {
    oldStart: start,
    oldLines: lines,
    newStart: start,
    newLines: lines,
    lines: Array.from({ length: lines }, (_, i) => ` ${String(i).padStart(width, '0')}`),
  };
}

describe('fileHunks (M2-02)', () => {
  it("takes Claude Code's structuredPatch when it is well formed", () => {
    const reported = [
      { oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, lines: ['-a', '+b'] },
    ];
    expect(
      fileHunks(
        'Edit',
        { file_path: '/a.ts', old_string: 'x', new_string: 'y' },
        {
          structuredPatch: reported,
        },
      ),
    ).toEqual({ file: '/a.ts', hunks: reported });
  });

  it('computes an Edit from its strings when the response has no usable patch', () => {
    const found = fileHunks(
      'Edit',
      { file_path: '/a.ts', old_string: 'a', new_string: 'b\nc' },
      { structuredPatch: [{ oldStart: 1, lines: ['?bad'] }] },
    );
    expect(found?.hunks).toEqual([
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-a', '+b', '+c'] },
    ]);
  });

  it('computes each MultiEdit edit and a Write against the original file', () => {
    const multi = fileHunks(
      'MultiEdit',
      {
        file_path: '/a.ts',
        edits: [
          { old_string: 'a', new_string: 'b' },
          { old_string: 'c', new_string: 'd' },
        ],
      },
      {},
    );
    expect(multi?.hunks.map((h) => h.lines)).toEqual([
      ['-a', '+b'],
      ['-c', '+d'],
    ]);
    const write = fileHunks(
      'Write',
      { file_path: '/b.md', content: 'x\ny\n' },
      { originalFile: 'x\n' },
    );
    expect(write?.hunks[0]?.lines).toEqual([' x', '+y']);
    const created = fileHunks('Write', { file_path: '/c.md', content: 'new\n' }, {});
    expect(created?.hunks[0]?.lines).toEqual(['+new']);
  });

  it('ignores other tools, a missing path and a MultiEdit without edits', () => {
    expect(fileHunks('Bash', { file_path: '/a.ts' }, {})).toBeUndefined();
    expect(fileHunks('Edit', { old_string: 'a' }, {})).toBeUndefined();
    expect(fileHunks('Edit', { file_path: 'x'.repeat(4097) }, {})).toBeUndefined();
    expect(fileHunks('MultiEdit', { file_path: '/a.ts' }, {})).toBeUndefined();
  });
});

describe('fitPatch (M2-02)', () => {
  it('renders the hunks in unified form', () => {
    expect(fitPatch([hunk(2, 4)])).toEqual({ patch: '@@ -4,2 +4,2 @@\n 0\n 1', truncated: false });
  });

  it(`AC: keeps the newest hunks within ${String(MAX_DIFF_LINES)} lines`, () => {
    const hunks = Array.from({ length: 30 }, (_, i) => hunk(99, i * 100 + 1));
    const fitted = fitPatch(hunks);
    expect(fitted.truncated).toBe(true);
    const lines = fitted.patch.split('\n');
    expect(lines.length).toBeLessThanOrEqual(MAX_DIFF_LINES);
    expect(lines.at(-100)).toBe('@@ -2901,99 +2901,99 @@');
    expect(lines[0]).toBe('@@ -1001,99 +1001,99 @@');
  });

  it('cuts a single hunk too long on its own, recounting its lines', () => {
    const fitted = fitPatch([hunk(5000)]);
    expect(fitted.truncated).toBe(true);
    expect(fitted.patch.split('\n')).toHaveLength(MAX_DIFF_LINES);
    expect(fitted.patch.startsWith(`@@ -1,${String(MAX_DIFF_LINES - 1)} +1,`)).toBe(true);
  });

  it('keeps the patch within the length cap and cuts long lines', () => {
    const wide = fitPatch([{ ...hunk(1), lines: [`+${'w'.repeat(5000)}`] }]);
    expect(wide.truncated).toBe(true);
    expect(wide.patch.split('\n')[1]).toHaveLength(MAX_DIFF_LINE_LENGTH);
    const long = fitPatch([hunk(1900, 1, 40)]);
    expect(long.truncated).toBe(true);
    expect(long.patch.length).toBeLessThanOrEqual(MAX_DIFF_LENGTH);
  });
});

describe('diffMessage (M2-02)', () => {
  it('answers a null patch when nothing was kept', () => {
    expect(diffMessage({ ...REQUEST, sessionId: SESSION, file: '/a.ts' }, undefined)).toEqual({
      t: 'diff',
      requestId: REQUEST.requestId,
      sessionId: SESSION,
      file: '/a.ts',
      patch: null,
      truncated: false,
    });
  });

  it('AC: shortens a patch of escaped text until the message fits one frame', () => {
    const escaped = Array.from({ length: 1500 }, () => `+${'\u0001'.repeat(40)}`);
    const stored = { hunks: [{ ...hunk(0), newLines: 1500, lines: escaped }], truncated: false };
    const message = diffMessage({ ...REQUEST, sessionId: SESSION, file: '/a.ts' }, stored);
    expect(messageBytes(message)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(message.truncated).toBe(true);
    expect(DiffMessage.safeParse(message).success).toBe(true);
  });
});

describe('createDiffStore (M2-02)', () => {
  const edit = (file: string, to: string, session = SESSION) =>
    post('Edit', { file_path: file, old_string: 'a', new_string: to }, {}, session);

  it('keeps every hunk of a file in order, per session', () => {
    const store = createDiffStore();
    store.observe(edit('/a.ts', 'b'));
    store.observe(edit('/a.ts', 'c'));
    store.observe({ hook_event_name: 'PreToolUse', session_id: SESSION, cwd: '/' });
    expect(store.get(SESSION, '/a.ts')?.hunks.map((h) => h.lines)).toEqual([
      ['-a', '+b'],
      ['-a', '+c'],
    ]);
    expect(store.get('other', '/a.ts')).toBeUndefined();
    expect(store.get(SESSION, '/b.ts')).toBeUndefined();
  });

  it('drops a file’s oldest hunks over its cap and marks it truncated', () => {
    const store = createDiffStore({ fileLength: 40 });
    store.observe(edit('/a.ts', 'first'));
    store.observe(edit('/a.ts', 'second'));
    const kept = store.get(SESSION, '/a.ts');
    expect(kept?.truncated).toBe(true);
    expect(kept?.hunks.map((h) => h.lines)).toEqual([['-a', '+second']]);
  });

  it(`keeps at most ${String(MAX_CHANGED_FILES)} files per session`, () => {
    const store = createDiffStore();
    for (let i = 0; i <= MAX_CHANGED_FILES; i += 1) store.observe(edit(`/${String(i)}.ts`, 'b'));
    expect(store.get(SESSION, '/0.ts')).toBeUndefined();
    expect(store.get(SESSION, `/${String(MAX_CHANGED_FILES)}.ts`)).toBeDefined();
  });

  it('drops the least recently updated session over the session or length budget', () => {
    const store = createDiffStore({ sessions: 2 });
    store.observe(edit('/a.ts', 'b', 's1'));
    store.observe(edit('/a.ts', 'b', 's2'));
    store.observe(edit('/a.ts', 'c', 's1'));
    store.observe(edit('/a.ts', 'b', 's3'));
    expect(store.get('s2', '/a.ts')).toBeUndefined();
    expect(store.get('s1', '/a.ts')).toBeDefined();

    const small = createDiffStore({ storeLength: 50 });
    small.observe(edit('/a.ts', 'x'.repeat(20), 's1'));
    small.observe(edit('/a.ts', 'y'.repeat(20), 's2'));
    expect(small.get('s1', '/a.ts')).toBeUndefined();
    small.observe(edit('/b.ts', 'z'.repeat(20), 's2'));
    expect(small.get('s2', '/a.ts')).toBeUndefined();
    expect(small.get('s2', '/b.ts')).toBeDefined();
  });
});
