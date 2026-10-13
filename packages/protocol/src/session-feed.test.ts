import { describe, expect, it } from 'vitest';

import type { Session } from './domain/session.js';
import { AgentMessage, EventMessage, SnapshotMessage } from './messages.js';
import {
  applyFeedEvent,
  clip,
  EMPTY_CONTENT,
  FeedEvent,
  fitSnapshot,
  MAX_CHANGED_FILES,
  MAX_FEED_TEXT_LENGTH,
  MAX_MESSAGE_BYTES,
  MAX_SESSION_STEPS,
  MAX_STEP_LENGTH,
  MAX_TOOL_DETAIL_LENGTH,
  messageBytes,
  toolStep,
} from './session-feed.js';

const MACHINE_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

function session(id: string, content: Partial<Session> = {}): Session {
  return {
    id,
    machineId: MACHINE_ID,
    repositoryId: null,
    agent: 'claude-code',
    state: 'working',
    statusText: 'Working',
    ...EMPTY_CONTENT,
    ...content,
  };
}

const machine: SnapshotMessage['machine'] = {
  id: MACHINE_ID,
  name: 'mac',
  platform: 'darwin',
  agentVersion: '0.1.0',
  agents: [],
};

/** A control character: JSON escapes it as `\u0001`, six bytes for one character. */
const ESCAPED = '\u0001';

describe('FeedEvent', () => {
  it('accepts every kind', () => {
    for (const event of [
      { kind: 'prompt', text: 'Fix it' },
      {
        kind: 'tool',
        tool: 'Edit',
        label: 'Edit a file',
        input: 'src/a.ts',
        response: 'ok',
        truncated: false,
        file: { name: '/repo/src/a.ts', added: 2, removed: 1 },
      },
      {
        kind: 'tool',
        tool: 'Bash',
        label: 'Run a command',
        input: '',
        response: '',
        truncated: true,
      },
      { kind: 'stop', text: 'Done' },
      { kind: 'stop', text: null },
      { kind: 'subagent_stop' },
      { kind: 'compact' },
      { kind: 'notification', text: 'Needs your attention' },
    ]) {
      expect(FeedEvent.safeParse(event).success).toBe(true);
    }
  });

  it('rejects oversized fields and unknown keys', () => {
    expect(FeedEvent.safeParse({ kind: 'prompt', text: 'x'.repeat(4001) }).success).toBe(false);
    expect(FeedEvent.safeParse({ kind: 'notification', text: '' }).success).toBe(false);
    expect(FeedEvent.safeParse({ kind: 'compact', extra: 1 }).success).toBe(false);
    expect(FeedEvent.safeParse({ kind: 'diff', body: '+a' }).success).toBe(false);
  });

  it('carries a positive sequence number', () => {
    const message = { t: 'event', sessionId: 's', seq: 0, event: { kind: 'compact' } };
    expect(EventMessage.safeParse(message).success).toBe(false);
    expect(EventMessage.safeParse({ ...message, seq: 1 }).success).toBe(true);
  });

  it('fits in one frame even when every character needs an escape', () => {
    const worst = (n: number) => ESCAPED.repeat(n);
    const events: FeedEvent[] = [
      { kind: 'prompt', text: worst(MAX_FEED_TEXT_LENGTH) },
      { kind: 'stop', text: worst(MAX_FEED_TEXT_LENGTH) },
      {
        kind: 'tool',
        tool: worst(MAX_STEP_LENGTH),
        label: worst(MAX_STEP_LENGTH),
        input: worst(MAX_TOOL_DETAIL_LENGTH),
        response: worst(MAX_TOOL_DETAIL_LENGTH),
        truncated: true,
        file: {
          name: worst(4096),
          added: Number.MAX_SAFE_INTEGER,
          removed: Number.MAX_SAFE_INTEGER,
        },
      },
    ];
    for (const event of events) {
      const message: EventMessage = {
        t: 'event',
        sessionId: worst(128),
        seq: Number.MAX_SAFE_INTEGER,
        event,
      };
      expect(AgentMessage.safeParse(message).success).toBe(true);
      expect(messageBytes(message)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    }
  });
});

describe('clip and toolStep', () => {
  it('cuts with an ellipsis only when needed', () => {
    expect(clip('abc', 3)).toBe('abc');
    expect(clip('abcd', 3)).toBe('ab…');
  });

  it('shows the label and the first input line', () => {
    expect(toolStep('Run a command', '  npm test\nnpm run build')).toBe('Run a command: npm test');
    expect(toolStep('Edit a file', '   \n')).toBe('Edit a file');
    expect(toolStep('Run a command', 'x'.repeat(500))).toHaveLength(MAX_STEP_LENGTH);
  });
});

describe('applyFeedEvent', () => {
  const tool = (input: string, file?: { name: string; added: number; removed: number }) =>
    ({
      kind: 'tool',
      tool: 'Edit',
      label: 'Edit a file',
      input,
      response: '',
      truncated: false,
      ...(file === undefined ? {} : { file }),
    }) as const;

  it('starts a turn on a prompt and keeps the changed files', () => {
    const before = session('s', {
      lastPrompt: 'old',
      lastAnswer: 'answer',
      steps: ['a'],
      changedFiles: [{ name: 'a.ts', added: 1, removed: 0 }],
    });
    expect(applyFeedEvent(before, { kind: 'prompt', text: 'new' })).toEqual({
      ...before,
      lastPrompt: 'new',
      lastAnswer: null,
      steps: [],
    });
  });

  it('adds steps, keeping the last 20, and sums line counts per file', () => {
    let content = { ...EMPTY_CONTENT };
    for (let i = 0; i < 25; i += 1) content = applyFeedEvent(content, tool(`step ${i}`));
    expect(content.steps).toHaveLength(MAX_SESSION_STEPS);
    expect(content.steps[0]).toBe('Edit a file: step 5');
    expect(content.changedFiles).toEqual([]);

    content = applyFeedEvent(content, tool('a', { name: 'a.ts', added: 2, removed: 1 }));
    content = applyFeedEvent(content, tool('b', { name: 'b.ts', added: 1, removed: 0 }));
    content = applyFeedEvent(content, tool('a', { name: 'a.ts', added: 3, removed: 4 }));
    expect(content.changedFiles).toEqual([
      { name: 'a.ts', added: 5, removed: 5 },
      { name: 'b.ts', added: 1, removed: 0 },
    ]);
  });

  it('keeps the last 50 changed files', () => {
    let content = { ...EMPTY_CONTENT };
    for (let i = 0; i < 55; i += 1) {
      content = applyFeedEvent(content, tool('x', { name: `f${i}`, added: 1, removed: 0 }));
    }
    expect(content.changedFiles).toHaveLength(MAX_CHANGED_FILES);
    expect(content.changedFiles[0]!.name).toBe('f5');
  });

  it('records the answer and the other events as steps', () => {
    let content = applyFeedEvent({ ...EMPTY_CONTENT }, { kind: 'stop', text: 'Done' });
    expect(content.lastAnswer).toBe('Done');
    content = applyFeedEvent(content, { kind: 'subagent_stop' });
    content = applyFeedEvent(content, { kind: 'compact' });
    content = applyFeedEvent(content, { kind: 'notification', text: 'Needs input' });
    expect(content.steps).toEqual(['Subagent finished', 'Context compacted', 'Needs input']);
  });
});

describe('fitSnapshot', () => {
  const big = (id: string, n: number) =>
    session(id, {
      lastPrompt: ESCAPED.repeat(n),
      lastAnswer: ESCAPED.repeat(n),
      steps: Array.from({ length: 20 }, () => ESCAPED.repeat(MAX_STEP_LENGTH)),
      changedFiles: Array.from({ length: 50 }, (_, i) => ({
        name: `${i}${ESCAPED.repeat(4000)}`,
        added: 1,
        removed: 1,
      })),
    });
  const snapshot = (
    sessions: Session[],
    extra: Partial<SnapshotMessage> = {},
  ): SnapshotMessage => ({
    t: 'snapshot',
    machine,
    sessions,
    pending: [],
    ...extra,
  });

  it('returns a snapshot that fits unchanged', () => {
    const small = snapshot([session('a', { lastPrompt: 'hi' })]);
    expect(fitSnapshot(small)).toBe(small);
  });

  it('thins the sessions with the most content first, keeping them listed', () => {
    const message = snapshot([session('a', { lastPrompt: 'hi' }), big('b', 4000), big('c', 1000)]);
    expect(messageBytes(message)).toBeGreaterThan(MAX_MESSAGE_BYTES);
    const fitted = fitSnapshot(message);
    expect(SnapshotMessage.safeParse(fitted).success).toBe(true);
    expect(messageBytes(fitted)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(fitted.sessions.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(fitted.sessions[0]!.lastPrompt).toBe('hi');
    expect(fitted.sessions[1]).toMatchObject(EMPTY_CONTENT);
  });

  it('leaves out the last sessions when thin ones still do not fit', () => {
    const message = snapshot(
      Array.from({ length: 100 }, (_, i) =>
        session(`${i}${'s'.repeat(100)}`, { statusText: ESCAPED.repeat(200) }),
      ),
    );
    const fitted = fitSnapshot(message);
    expect(messageBytes(fitted)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(fitted.sessions.length).toBeGreaterThan(0);
    expect(fitted.sessions.length).toBeLessThan(100);
    expect(fitted.sessions[0]!.id).toBe(message.sessions[0]!.id);
  });

  it('gives up without sessions when the rest is too large on its own', () => {
    const fitted = fitSnapshot(snapshot([session('a')]), 10);
    expect(fitted.sessions).toEqual([]);
  });
});
