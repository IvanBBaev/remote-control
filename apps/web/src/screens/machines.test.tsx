import { HOOK_SEEN, NO_HOOK_SEEN, SETUP_CHECKLIST } from '@remote-control/protocol';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import type { MachineView } from '../realtime/realtime-store.js';
import { createTestPhone } from '../realtime/test-phone.js';
import { fixtures } from '../test-fixtures.js';
import { renderApp } from '../test-render.js';
import type { RenderedApp } from '../test-render.js';

let mounted: RenderedApp | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

function machine(
  deviceId: string,
  name: string,
  online: boolean,
  lastSeen: number | null,
): MachineView {
  return {
    deviceId,
    name,
    online,
    lastSeen,
    session: 'none',
    machine: null,
    sessions: [],
    history: null,
    repositories: [],
  };
}

describe('machines screen', () => {
  it('invites the first pairing when nothing is paired', async () => {
    mounted = await renderApp('/machines', fixtures.onboarded);
    expect(mounted.container.textContent).toContain('No computers yet.');
    expect(mounted.container.querySelector('a.button')?.textContent).toBe(
      'Add your first computer',
    );
  });

  it('lists paired computers by name with their presence', async () => {
    const test = createTestPhone();
    const now = test.timer.now();
    mounted = await renderApp('/machines', fixtures.onboarded, { phone: test.phone });
    act(() => {
      test.phone.realtime.setState({
        confirmedAt: now,
        machines: {
          b: machine('b', 'Work laptop', false, now - 5 * 60_000),
          a: machine('a', 'Studio Mac', true, null),
        },
      });
    });
    const rows = [...mounted.container.querySelectorAll('.machine-list li')];
    expect(rows.map((row) => [row.className, row.textContent])).toEqual([
      ['online', 'Studio MacOnline'],
      ['offline', 'Work laptopMachine offline — last seen 5 minutes ago'],
    ]);
    expect(mounted.container.querySelector('a.button')?.textContent).toBe('Add a computer');
  });

  it("shows the computer's own history per repository (M2-06)", async () => {
    const test = createTestPhone();
    const now = test.timer.now();
    mounted = await renderApp('/machines', fixtures.onboarded, { phone: test.phone });
    const entry = {
      sessions: 2,
      toolCalls: 40,
      approvals: 3,
      denials: 1,
      activeMs: 3_900_000,
    };
    act(() => {
      test.phone.realtime.setState({
        confirmedAt: now,
        relayOffset: 0,
        machines: {
          a: {
            ...machine('a', 'Studio Mac', true, null),
            history: [
              { project: 'api', ...entry, lastActiveAt: now - 5 * 60_000 },
              { project: 'web', ...entry, lastActiveAt: null },
            ],
          },
          b: { ...machine('b', 'Work laptop', true, null), history: [] },
        },
      });
    });
    const history = [...mounted.container.querySelectorAll('.machine-history p')];
    expect(history.map((line) => line.textContent)).toEqual([
      'On this computer:',
      'api 2 sessions, 40 tool calls, 1 h 5 min active, 3 approved, 1 denied · last active 5 minutes ago',
      'web 2 sessions, 40 tool calls, 1 h 5 min active, 3 approved, 1 denied',
    ]);
    expect(mounted.container.querySelectorAll('.machine-history')).toHaveLength(1);
  });

  it("shows this phone's counters per computer and project (M1-11)", async () => {
    const test = createTestPhone();
    const now = test.timer.now();
    mounted = await renderApp('/machines', fixtures.onboarded, { phone: test.phone });
    act(() => {
      test.phone.realtime.setState({
        confirmedAt: now,
        machines: { a: machine('a', 'Studio Mac', true, null) },
      });
      test.phone.usage.setState({
        machines: {
          a: {
            web: { approvals: 1, denials: 0, sessions: 1 },
            api: { approvals: 2, denials: 1, sessions: 1 },
          },
        },
      });
    });
    const usage = [...mounted.container.querySelectorAll('.machine-usage p')];
    expect(usage.map((line) => line.textContent)).toEqual([
      'From this phone: 3 approved, 1 denied, 2 sessions',
      'api 2 approved, 1 denied, 1 session',
      'web 1 approved, 0 denied, 1 session',
    ]);
  });

  it("shows each computer's paired phones, hooks and repository trust (M1-07)", async () => {
    const test = createTestPhone();
    const now = test.timer.now();
    mounted = await renderApp('/machines', fixtures.onboarded, { phone: test.phone });
    act(() => {
      test.phone.realtime.setState({
        confirmedAt: now,
        machines: {
          a: {
            ...machine('a', 'Studio Mac', true, null),
            hooksInstalled: false,
            repositories: [
              { id: 'r1', machineId: 'a', name: 'api', path: '/src/api', hookSeen: true },
              { id: 'r2', machineId: 'a', name: 'web', path: '/src/web', hookSeen: false },
              { id: 'r3', machineId: 'a', name: 'old', path: '/src/old' },
            ],
            devices: [
              { id: 'p1', name: 'iPhone', pairedAt: Date.UTC(2026, 9, 1, 12) },
              { id: 'p2', name: 'Pixel', pairedAt: Date.UTC(2026, 9, 12, 23, 30) },
            ],
          },
          b: { ...machine('b', 'Work laptop', true, null), hooksInstalled: true },
        },
      });
    });
    const setups = [...mounted.container.querySelectorAll('.machine-setup')];
    expect(setups).toHaveLength(1);
    expect([...setups[0]!.querySelectorAll('p')].map((line) => line.textContent)).toEqual([
      'Claude Code hooks are not installed. Run `remotectl hooks install` on the computer.',
      `api ${HOOK_SEEN}`,
      `web ${NO_HOOK_SEEN}`,
    ]);
    const devices = [...setups[0]!.querySelectorAll('.paired-devices li')];
    expect(devices.map((row) => row.textContent)).toEqual([
      'iPhone paired 2026-10-01Revoke',
      'Pixel paired 2026-10-12Revoke',
    ]);
    const revoke = devices[0]!.querySelector('button')!;
    expect(revoke.disabled).toBe(true);
    expect(revoke.title).toBe('Revoking a phone arrives in a later version.');
  });

  it.each([
    ['no computers', {}],
    ['a computer', { a: machine('a', 'Studio Mac', false, null) }],
  ])('lists the shared "Can\'t connect?" checks with %s', async (_name, machines) => {
    const test = createTestPhone();
    mounted = await renderApp('/machines', fixtures.onboarded, { phone: test.phone });
    act(() => {
      test.phone.realtime.setState({ confirmedAt: test.timer.now(), machines });
    });
    const checklist = mounted.container.querySelector('details.setup-checklist')!;
    expect(checklist.querySelector('summary')?.textContent).toBe("Can't connect?");
    expect([...checklist.querySelectorAll('li')].map((item) => item.textContent)).toEqual(
      SETUP_CHECKLIST.map((check) => `${check.question} ${check.fix}`),
    );
  });
});
