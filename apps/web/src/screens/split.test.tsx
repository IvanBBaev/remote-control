import type { ApprovalRequest, Session } from '@remote-control/protocol';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MediaQuery } from '../ports/media-query.js';
import type { MachineView } from '../realtime/realtime-store.js';
import { createTestPhone } from '../realtime/test-phone.js';
import type { TestPhone } from '../realtime/test-phone.js';
import { fixtures } from '../test-fixtures.js';
import { click, renderApp, settle } from '../test-render.js';
import type { RenderedApp } from '../test-render.js';
import { TAP_GUARD_MS } from './approval.js';

const MAC = 'agent-mac';
const REQUEST = '0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';

let mounted: RenderedApp | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

/** A `(min-width: 900px)` query on a window the test resizes. */
function screenWidth(width: number) {
  const listeners = new Set<() => void>();
  let current = width;
  const query: MediaQuery = {
    matches: () => current >= 900,
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
  return {
    query,
    resize(next: number) {
      act(() => {
        current = next;
        for (const listener of listeners) listener();
      });
    },
  };
}

function session(id: string, name: string): Session {
  return {
    id,
    machineId: MAC,
    repositoryId: null,
    agent: 'claude-code',
    state: 'waiting',
    statusText: 'Waiting for approval',
    name,
    lastPrompt: null,
    lastAnswer: null,
    steps: [],
    changedFiles: [],
  };
}

const machine: MachineView = {
  deviceId: MAC,
  name: 'Studio Mac',
  online: true,
  lastSeen: null,
  session: 'open',
  machine: null,
  sessions: [session('sess-1', 'fix-tests'), session('sess-2', 'docs')],
  history: null,
  repositories: [],
};

function approval(change: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: REQUEST,
    sessionId: 'sess-1',
    requestHash: 'a'.repeat(64),
    toolLabel: 'Run a command',
    toolName: 'Bash',
    content: 'npm test',
    truncated: false,
    suggestions: [],
    expiresAt: 0,
    alwaysSupported: false,
    ...change,
  };
}

async function open(path: string, width: number, request?: ApprovalRequest) {
  const screen = screenWidth(width);
  const test = createTestPhone();
  vi.spyOn(test.phone, 'connect').mockResolvedValue();
  const decide = vi
    .spyOn(test.phone, 'decide')
    .mockResolvedValue({ ok: true, decisionHash: 'h', asserted: true });
  test.phone.realtime.setState({
    connection: 'open',
    machines: { [MAC]: machine },
    requests:
      request === undefined
        ? {}
        : {
            [request.id]: {
              machineId: MAC,
              request,
              deadline: test.timer.now() + 120_000,
              status: 'pending',
            },
          },
  });
  mounted = await renderApp(path, fixtures.onboarded, {
    platform: {
      requestNotificationPermission: () => Promise.resolve('granted'),
      wideLayout: screen.query,
    },
    phone: test.phone,
  });
  return { screen, test, decide };
}

const list = () => mounted!.container.querySelector('nav[aria-label="Sessions"]');
const detail = () => mounted!.container.querySelector('.split-detail');
const text = () => mounted?.container.textContent ?? '';

const tick = (test: TestPhone, ms: number) => {
  act(() => {
    test.timer.advance(ms);
  });
};

async function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
    await Promise.resolve();
  });
  await settle();
}

describe('two-pane layout (M2-05)', () => {
  it('AC: at 1280 px the sessions list and the open session sit side by side', async () => {
    await open('/sessions/sess-1', 1280);
    expect(list()).not.toBeNull();
    expect(detail()?.querySelector('h1')?.textContent).toBe('fix-tests');
    const links = [...list()!.querySelectorAll('.session-list a')];
    expect(links.map((a) => a.getAttribute('aria-current'))).toEqual(['page', null]);
    await click(links[1] as HTMLElement);
    expect(mounted!.path()).toBe('/sessions/sess-2');
    expect(list()).not.toBeNull();
    expect(detail()?.querySelector('h1')?.textContent).toBe('docs');
  });

  it('asks to pick a session on the right while none is open', async () => {
    await open('/sessions', 1280);
    expect(list()?.textContent).toContain('fix-tests');
    expect(detail()?.textContent).toContain('Pick a session on the left');
    expect(mounted!.container.querySelectorAll('.session-list')).toHaveLength(1);
  });

  it('keeps one screen per route on a phone and follows a resize', async () => {
    const { screen } = await open('/sessions/sess-1', 390);
    expect(list()).toBeNull();
    expect(mounted!.heading()).toBe('fix-tests');
    screen.resize(1280);
    expect(list()).not.toBeNull();
    screen.resize(800);
    expect(list()).toBeNull();
    expect(mounted!.heading()).toBe('fix-tests');
  });

  it('stays on one pane when the platform cannot tell the width', async () => {
    const test = createTestPhone();
    vi.spyOn(test.phone, 'connect').mockResolvedValue();
    test.phone.realtime.setState({ connection: 'open', machines: { [MAC]: machine } });
    mounted = await renderApp('/sessions', fixtures.onboarded, { phone: test.phone });
    expect(list()).toBeNull();
    expect(text()).toContain('fix-tests');
  });

  it('shows a request next to the sessions list', async () => {
    await open(`/requests/${REQUEST}`, 1280, approval());
    expect(list()).not.toBeNull();
    expect(detail()?.textContent).toContain('Run a command');
  });
});

describe('Allow/Deny keys (M2-05)', () => {
  it.each([
    ['a', 'allow'],
    ['A', 'allow'],
    ['d', 'deny'],
  ] as const)('"%s" decides %s through the passkey', async (key, kind) => {
    const { test, decide } = await open(`/requests/${REQUEST}`, 1280, approval());
    tick(test, TAP_GUARD_MS);
    await press(key);
    expect(decide).toHaveBeenCalledOnce();
    expect(decide).toHaveBeenCalledWith(MAC, expect.objectContaining({ id: REQUEST }), kind);
    await press(key);
    expect(decide).toHaveBeenCalledOnce();
  });

  it('ignores keys right after the card appears, as it ignores taps', async () => {
    const { test, decide } = await open(`/requests/${REQUEST}`, 1280, approval());
    await press('a');
    expect(decide).not.toHaveBeenCalled();
    tick(test, TAP_GUARD_MS);
    await press('a');
    expect(decide).toHaveBeenCalledOnce();
  });

  it.each([
    ['a held down', { repeat: true }],
    ['Ctrl+A', { ctrlKey: true }],
    ['Cmd+A', { metaKey: true }],
    ['Alt+A', { altKey: true }],
  ])('ignores %s', async (_, init) => {
    const { test, decide } = await open(`/requests/${REQUEST}`, 1280, approval());
    tick(test, TAP_GUARD_MS);
    await press('a', init);
    expect(decide).not.toHaveBeenCalled();
  });

  it('ignores keys typed into a field', async () => {
    const { test, decide } = await open(`/requests/${REQUEST}`, 1280, approval());
    tick(test, TAP_GUARD_MS);
    const input = document.createElement('input');
    mounted!.container.append(input);
    await press('d', {}, input);
    expect(decide).not.toHaveBeenCalled();
  });

  it('never allows a truncated request by key, but still denies', async () => {
    const { test, decide } = await open(
      `/requests/${REQUEST}`,
      1280,
      approval({ truncated: true }),
    );
    tick(test, TAP_GUARD_MS);
    await press('a');
    expect(decide).not.toHaveBeenCalled();
    await press('d');
    expect(decide).toHaveBeenCalledWith(MAC, expect.anything(), 'deny');
  });

  it('names the keys on the buttons and shows the hint only on a wide screen', async () => {
    const { screen } = await open(`/requests/${REQUEST}`, 1280, approval());
    expect(mounted!.button('Allow').getAttribute('aria-keyshortcuts')).toBe('A');
    expect(mounted!.button('Deny').getAttribute('aria-keyshortcuts')).toBe('D');
    expect(mounted!.container.querySelector('.keyboard-hint')?.textContent).toContain(
      'Your passkey still confirms',
    );
    screen.resize(390);
    expect(mounted!.container.querySelector('.keyboard-hint')).toBeNull();
  });

  it('stops listening once the request is answered', async () => {
    const { test, decide } = await open(`/requests/${REQUEST}`, 1280, approval());
    tick(test, TAP_GUARD_MS);
    await press('d');
    expect(text()).toContain('Deny sent');
    expect(mounted!.container.querySelector('.keyboard-hint')).toBeNull();
    await press('a');
    expect(decide).toHaveBeenCalledOnce();
  });
});
