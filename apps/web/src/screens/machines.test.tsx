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
  return { deviceId, name, online, lastSeen, session: 'none', machine: null, sessions: [] };
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
});
