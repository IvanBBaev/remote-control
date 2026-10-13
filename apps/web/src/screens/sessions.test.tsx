import { MAX_MESSAGE_BYTES, messageBytes, SnapshotMessage } from '@remote-control/protocol';
import type { Session } from '@remote-control/protocol';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MachineView } from '../realtime/realtime-store.js';
import { createTestPhone } from '../realtime/test-phone.js';
import { fixtures } from '../test-fixtures.js';
import { click, renderApp, settle } from '../test-render.js';
import type { RenderedApp } from '../test-render.js';
import { baseName } from './main.js';

const MAC = '0d6f8a52-3c5e-4f0b-9a4e-222222222222';
const LAPTOP = 'agent-laptop';

let mounted: RenderedApp | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

function session(change: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    machineId: MAC,
    repositoryId: null,
    agent: 'claude-code',
    state: 'working',
    statusText: 'Working',
    lastPrompt: null,
    lastAnswer: null,
    steps: [],
    changedFiles: [],
    ...change,
  };
}

function machine(deviceId: string, name: string, sessions: Session[]): MachineView {
  return {
    deviceId,
    name,
    online: true,
    lastSeen: null,
    session: 'open',
    machine: null,
    sessions,
    history: null,
    repositories: [],
  };
}

async function open(path: string, machines: MachineView[]) {
  const test = createTestPhone();
  vi.spyOn(test.phone, 'connect').mockResolvedValue();
  test.phone.realtime.setState({
    connection: 'open',
    machines: Object.fromEntries(machines.map((m) => [m.deviceId, m])),
  });
  mounted = await renderApp(path, fixtures.onboarded, { phone: test.phone });
  return test;
}

const text = () => mounted?.container.textContent ?? '';
const all = (selector: string) => [...mounted!.container.querySelectorAll(selector)];

/** A session in the middle of a turn, as the agent's feed builds it (M1-05). */
const FIXTURE = session({
  name: 'fix-tests',
  lastPrompt: 'Fix the failing test',
  steps: ['Run a command: npm test', 'Edit a file: src/a.ts', 'Run a command: npm test'],
  changedFiles: [
    { name: '/Users/me/code/api/src/a.ts', added: 2, removed: 1 },
    { name: 'C:\\code\\api\\b.md', added: 3, removed: 0 },
  ],
  lastAnswer: 'The test passes now.',
});

describe('sessions list (M1-05)', () => {
  it('lists sessions per computer with the state badge and what they wait for', async () => {
    await open('/sessions', [
      machine(MAC, 'Studio Mac', [
        session({ name: 'fix-tests' }),
        session({ id: 'sess/2', state: 'waiting', statusText: 'Waiting for approval' }),
      ]),
      machine(LAPTOP, 'Air', [session({ id: 'sess-3', machineId: LAPTOP, state: 'ended' })]),
      machine('agent-idle', 'Idle box', []),
    ]);
    expect(all('.session-group h2').map((h) => h.textContent)).toEqual(['Air', 'Studio Mac']);
    const links = all('.session-list a');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/sessions/sess-3',
      '/sessions/sess-1',
      '/sessions/sess%2F2',
    ]);
    expect(links[1]!.textContent).toBe('fix-testsWorkingWorking');
    expect(links[2]!.querySelector('.badge.state-waiting')?.textContent).toBe('Needs you');
    expect(links[2]!.textContent).toContain('Waiting for approval');
    expect(links[0]!.textContent).toContain('Ended');
    expect(text()).not.toContain('No sessions yet');
    expect(text()).toContain('New session');
  });

  it('says so when no computer has a session', async () => {
    await open('/sessions', [machine(MAC, 'Studio Mac', [])]);
    expect(text()).toContain('No sessions yet.');
  });
});

describe('session view (M1-05, D21)', () => {
  it('renders a fixture session that fits in one message', async () => {
    const snapshot: SnapshotMessage = {
      t: 'snapshot',
      machine: {
        id: MAC,
        name: 'Studio Mac',
        platform: 'darwin',
        agentVersion: '0.1.0',
        agents: [],
      },
      sessions: [FIXTURE],
      pending: [],
    };
    expect(SnapshotMessage.safeParse(snapshot).success).toBe(true);
    expect(messageBytes(snapshot)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);

    await open('/sessions/sess-1', [machine(MAC, 'Studio Mac', [FIXTURE])]);
    expect(mounted!.heading()).toBe('fix-tests');
    expect(text()).toContain('working · Working');
    expect(text()).toContain('Fix the failing test');
    expect(all('.session-steps li').map((li) => li.textContent)).toEqual(FIXTURE.steps);
    expect(text()).toContain('The test passes now.');
    expect(text()).not.toContain('Nothing has happened');

    // File names only; the full path after a tap. No diff bodies anywhere.
    const files = all('.changed-files li');
    expect(files.map((li) => li.textContent)).toEqual(['a.ts +2 −1', 'b.md +3 −0']);
    expect(text()).not.toContain('/Users/me/code');
    const toggle = files[0]!.querySelector('button')!;
    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(files[0]!.querySelector('code')?.textContent).toBe('/Users/me/code/api/src/a.ts');
    await click(toggle);
    expect(files[0]!.querySelector('code')).toBeNull();
  });

  it('follows live feed updates and says when nothing has happened yet', async () => {
    const test = await open('/sessions/sess-1', [machine(MAC, 'Studio Mac', [session()])]);
    expect(text()).toContain('Nothing has happened in this session yet.');
    expect(all('.session-part')).toHaveLength(0);
    act(() => {
      test.phone.realtime.setState((state) => ({
        machines: {
          [MAC]: { ...state.machines[MAC]!, sessions: [session({ steps: ['Context compacted'] })] },
        },
      }));
    });
    await settle();
    expect(text()).not.toContain('Nothing has happened');
    expect(all('.session-steps li').map((li) => li.textContent)).toEqual(['Context compacted']);
  });
});

describe('baseName', () => {
  it('keeps the last path segment', () => {
    expect(baseName('/a/b/c.ts')).toBe('c.ts');
    expect(baseName('C:\\a\\b.md')).toBe('b.md');
    expect(baseName('plain')).toBe('plain');
    expect(baseName('/trailing/')).toBe('/trailing/');
  });
});
