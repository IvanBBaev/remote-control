import { MAX_DIFF_LINES } from '@remote-control/protocol';
import type { Session } from '@remote-control/protocol';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { diffKey } from '../realtime/realtime-store.js';
import type { DiffView, MachineView } from '../realtime/realtime-store.js';
import { createTestPhone } from '../realtime/test-phone.js';
import { fixtures } from '../test-fixtures.js';
import { click, renderApp, settle } from '../test-render.js';
import type { RenderedApp } from '../test-render.js';
import { parseHunks } from './diff-view.js';

/** CPU time this test process has used, in ms (jsdom runs in Node; the app types omit it). */
function cpuMs(): number {
  const { process } = globalThis as unknown as {
    process: { cpuUsage(): { user: number; system: number } };
  };
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
}

const MAC = '0d6f8a52-3c5e-4f0b-9a4e-222222222222';
const FILE = '/Users/me/code/api/src/a.ts';
const KEY = diffKey(MAC, 'sess-1', FILE);

/** A two-hunk patch as the agent's `fitPatch` writes it (M2-02 fixture). */
const FIXTURE_PATCH = [
  '@@ -1,3 +1,4 @@',
  ' import { a } from "./a";',
  '-const x = 1;',
  '+const x = 2;',
  '+const y = 3;',
  ' export { x };',
  '@@ -40,2 +41,2 @@',
  ' function f() {',
  `-  return ${'"long"'.repeat(80)};`,
  '+  return 0;',
].join('\n');

let mounted: RenderedApp | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

const SESSION: Session = {
  id: 'sess-1',
  machineId: MAC,
  repositoryId: null,
  agent: 'claude-code',
  state: 'working',
  statusText: 'Working',
  lastPrompt: null,
  lastAnswer: null,
  steps: [],
  changedFiles: [{ name: FILE, added: 2, removed: 1 }],
};

const MACHINE: MachineView = {
  deviceId: MAC,
  name: 'Studio Mac',
  online: true,
  lastSeen: null,
  session: 'open',
  machine: null,
  sessions: [SESSION],
  history: null,
  repositories: [],
};

/** The session screen with the file opened; returns the phone's `diff` spy. */
async function openFile() {
  const test = createTestPhone();
  vi.spyOn(test.phone, 'connect').mockResolvedValue();
  const asked = vi.spyOn(test.phone, 'diff').mockImplementation((machineId, sessionId, file) => {
    test.phone.realtime.setState((state) => ({
      diffs: {
        ...state.diffs,
        [diffKey(machineId, sessionId, file)]: { requestId: 'r1', status: 'loading' },
      },
    }));
  });
  test.phone.realtime.setState({ connection: 'open', machines: { [MAC]: MACHINE } });
  mounted = await renderApp('/sessions/sess-1', fixtures.onboarded, { phone: test.phone });
  await click(mounted.container.querySelector<HTMLButtonElement>('.changed-files button')!);
  const answer = (view: Omit<DiffView, 'requestId'>) => {
    act(() => {
      test.phone.realtime.setState({ diffs: { [KEY]: { requestId: 'r1', ...view } } });
    });
  };
  return { test, asked, answer };
}

const text = () => mounted?.container.textContent ?? '';
const all = (selector: string) => [...mounted!.container.querySelectorAll(selector)];

describe('diff view (M2-02)', () => {
  it('asks only when the file is opened, then renders the fixture diff', async () => {
    const { asked, answer } = await openFile();
    expect(asked).toHaveBeenCalledExactlyOnceWith(MAC, 'sess-1', FILE);
    expect(text()).toContain('Loading the diff…');
    answer({ status: 'ready', patch: FIXTURE_PATCH, truncated: false });
    await settle();
    expect(all('.diff-header').map((h) => h.textContent)).toEqual([
      '@@ -1,3 +1,4 @@',
      '@@ -40,2 +41,2 @@',
    ]);
    expect(all('pre.diff .add').map((l) => l.textContent)).toEqual([
      '+const x = 2;\n+const y = 3;\n',
      '+  return 0;\n',
    ]);
    expect(all('pre.diff .del')).toHaveLength(2);
    expect(all('pre.diff .ctx').map((l) => l.textContent)).toEqual([
      ' import { a } from "./a";\n',
      ' export { x };\n',
      ' function f() {\n',
    ]);
    // No syntax highlighting: a line is one text node.
    expect(all('pre.diff span span')).toHaveLength(0);
    expect(text()).not.toContain('left out');
  });

  it('AC: collapses and expands a hunk', async () => {
    const { answer } = await openFile();
    answer({ status: 'ready', patch: FIXTURE_PATCH, truncated: false });
    await settle();
    const [first] = all('.diff-header') as HTMLButtonElement[];
    expect(first!.getAttribute('aria-expanded')).toBe('true');
    await click(first!);
    expect(first!.getAttribute('aria-expanded')).toBe('false');
    expect(all('pre.diff')).toHaveLength(1);
    await click(first!);
    expect(all('pre.diff')).toHaveLength(2);
  });

  it('AC: renders a 2,000-line diff in under 200 ms and caps what it shows', async () => {
    // Alternating kinds: the most nodes a diff of this size can take.
    const lines = Array.from({ length: 2600 }, (_, i) => `${i % 2 ? '+' : '-'}line ${String(i)}`);
    const patch = [`@@ -1,1300 +1,1300 @@`, ...lines].join('\n');
    const { answer } = await openFile();
    // Best of three after a warm-up. It counts the CPU time the render takes, not the wall
    // clock: on a loaded machine or CI runner the scheduler, not the render, owns the wall
    // clock, while the render's own work is what the phone pays.
    answer({ status: 'ready', patch: FIXTURE_PATCH, truncated: false });
    await settle();
    let best = Infinity;
    for (const variant of [patch, `${patch}\n+end`, patch]) {
      answer({ status: 'unavailable' });
      await settle();
      const started = cpuMs();
      answer({ status: 'ready', patch: variant, truncated: true });
      await settle();
      best = Math.min(best, cpuMs() - started);
    }
    expect(best).toBeLessThan(200);
    const shown = all('pre.diff span').map((span) => span.textContent);
    expect(shown.join('').split('\n')).toHaveLength(MAX_DIFF_LINES + 1);
    expect(text()).toContain('600 more lines not shown.');
    expect(text()).toContain('Only the latest changes are shown');
  });

  it('says when the diff is unavailable or empty', async () => {
    const { answer } = await openFile();
    answer({ status: 'unavailable' });
    await settle();
    expect(text()).toContain('The diff is not available.');
    answer({ status: 'ready', patch: '', truncated: false });
    await settle();
    expect(text()).toContain('No changes to show.');
  });

  it('parses hunks, ignoring anything before the first header', () => {
    expect(parseHunks('junk\n@@ -1 +1 @@\n-a\n+b')).toEqual([
      { header: '@@ -1 +1 @@', lines: ['-a', '+b'] },
    ]);
  });
});
