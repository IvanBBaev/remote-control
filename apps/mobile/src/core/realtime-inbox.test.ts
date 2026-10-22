import type { ApprovalRequest, Question, Session } from '@remote-control/protocol';
import { createRealtimeStore } from '@remote-control/phone-core/realtime/realtime-store';
import type {
  MachineView,
  RealtimeState,
  RequestView,
} from '@remote-control/phone-core/realtime/realtime-store';
import { describe, expect, it } from 'vitest';

import { pendingRequestFor, sessionsFromRealtime } from './realtime-inbox';

const NOW = 1_800_000_000_000;
const MAC = 'agent-mac';
const HASH = 'a'.repeat(64);

function machine(overrides: Partial<MachineView> = {}): MachineView {
  return {
    deviceId: MAC,
    name: 'From pairing',
    online: true,
    lastSeen: null,
    session: 'open',
    machine: {
      id: MAC,
      name: 'MacBook Pro',
      platform: 'darwin',
      agentVersion: '0.0.0',
      agents: [],
    },
    sessions: [],
    history: null,
    repositories: [],
    ...overrides,
  };
}

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    machineId: MAC,
    repositoryId: null,
    agent: 'claude-code',
    state: 'working',
    statusText: 'Editing files',
    lastPrompt: 'Fix the bug',
    lastAnswer: null,
    steps: [],
    changedFiles: [],
    ...overrides,
  };
}

function approval(id: string, sessionId: string, deadline: number): RequestView {
  const request: ApprovalRequest = {
    id,
    sessionId,
    requestHash: HASH,
    toolLabel: 'Run a command',
    toolName: 'Bash',
    project: 'billing-api',
    content: 'pnpm test',
    truncated: false,
    suggestions: [],
    expiresAt: deadline,
    alwaysSupported: true,
  };
  return { machineId: MAC, deadline, status: 'pending', request };
}

function question(id: string, sessionId: string, deadline: number): RequestView {
  const request: Question = {
    id,
    sessionId,
    requestHash: HASH,
    expiresAt: deadline,
    questions: [
      {
        text: 'Which layout?',
        header: 'Layout',
        options: [{ label: 'Grid' }, { label: 'List', description: 'One column' }],
        multi: false,
      },
    ],
  };
  return { machineId: MAC, deadline, status: 'pending', kind: 'question', request };
}

function state(
  machines: readonly MachineView[],
  requests: readonly RequestView[] = [],
): RealtimeState {
  return {
    ...createRealtimeStore().getState(),
    machines: Object.fromEntries(machines.map((view) => [view.deviceId, view])),
    requests: Object.fromEntries(requests.map((view) => [view.request.id, view])),
  };
}

describe('sessionsFromRealtime', () => {
  it('is empty with nothing paired', () => {
    expect(sessionsFromRealtime(state([]), NOW)).toEqual([]);
  });

  it('lists snapshot sessions with their state', () => {
    const view = machine({
      sessions: [
        session('s-1', { lastAnswer: 'Done.' }),
        session('s-2', { state: 'idle', statusText: '', lastPrompt: null }),
        session('s-3', { state: 'ended', statusText: '', lastPrompt: 'Ship it', name: 'release' }),
        session('s-4', { state: 'waiting' }),
      ],
    });
    expect(sessionsFromRealtime(state([view]), NOW)).toEqual([
      {
        id: 's-1',
        machine: 'MacBook Pro',
        project: 'MacBook Pro',
        title: 'Editing files',
        status: 'working',
        updatedAt: NOW,
        lastTurn: 'Done.',
      },
      {
        id: 's-2',
        machine: 'MacBook Pro',
        project: 'MacBook Pro',
        title: 'Claude Code session',
        status: 'idle',
        updatedAt: NOW,
      },
      {
        id: 's-3',
        machine: 'MacBook Pro',
        project: 'release',
        title: 'Ship it',
        status: 'done',
        updatedAt: NOW,
        lastTurn: 'Ship it',
      },
      expect.objectContaining({ id: 's-4', status: 'working' }),
    ]);
  });

  it('attaches the oldest pending approval and question to their session', () => {
    const view = machine({ sessions: [session('s-1')] });
    const requests = [
      approval('r-late', 's-1', NOW + 90_000),
      approval('r-early', 's-1', NOW + 30_000),
      question('q-1', 's-1', NOW + 60_000),
      { ...approval('r-done', 's-1', NOW + 10_000), status: 'resolved' } as RequestView,
    ];
    const [only] = sessionsFromRealtime(state([view], requests), NOW);
    expect(only).toMatchObject({
      id: 's-1',
      project: 'billing-api',
      approval: {
        requestId: 'r-early',
        toolLabel: 'Run a command',
        toolKind: 'command',
        detail: 'pnpm test',
        cwd: 'billing-api',
        expiresAt: NOW + 30_000,
        canAlways: true,
      },
      question: {
        requestId: 'q-1',
        header: 'Layout',
        prompt: 'Which layout?',
        options: [{ label: 'Grid' }, { label: 'List', description: 'One column' }],
        expiresAt: NOW + 60_000,
      },
    });
  });

  it('lists a session known only from a pending request, on the pairing name', () => {
    const request = question('q-1', 's-new', NOW + 60_000);
    const bare = {
      ...request,
      request: { ...request.request, questions: [] },
    } as unknown as RequestView;
    const [only] = sessionsFromRealtime(state([machine({ machine: null })], [bare]), NOW);
    expect(only).toMatchObject({
      id: 's-new',
      machine: 'From pairing',
      project: 'From pairing',
      title: 'Claude Code session',
      status: 'working',
      question: { header: 'Question', prompt: '', options: [] },
    });
  });

  it("keeps each computer's requests on that computer", () => {
    const other = machine({ deviceId: 'agent-pc', machine: null, name: 'PC' });
    const sessions = sessionsFromRealtime(
      state([machine(), other], [approval('r-1', 's-1', NOW + 1)]),
      NOW,
    );
    expect(sessions.map((s) => [s.id, s.machine])).toEqual([['s-1', 'MacBook Pro']]);
  });

  it('leaves the cwd empty when the agent sent no project', () => {
    const view = approval('r-1', 's-1', NOW + 1);
    const { project: _project, ...request } = view.request as ApprovalRequest;
    const [only] = sessionsFromRealtime(
      state([machine()], [{ ...view, request } as RequestView]),
      NOW,
    );
    expect(only?.approval?.cwd).toBe('');
  });
});

describe('pendingRequestFor', () => {
  it('finds a pending request and ignores a settled one', () => {
    const live = approval('r-1', 's-1', NOW + 1);
    const done = { ...approval('r-2', 's-1', NOW + 1), status: 'expired' } as RequestView;
    const current = state([machine()], [live, done]);
    expect(pendingRequestFor(current, 'r-1')).toBe(live);
    expect(pendingRequestFor(current, 'r-2')).toBeUndefined();
    expect(pendingRequestFor(current, 'r-3')).toBeUndefined();
  });
});
