import type { ApprovalRequest } from '@remote-control/protocol';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MachineView, RequestView } from '../realtime/realtime-store.js';
import { createTestPhone } from '../realtime/test-phone.js';
import type { TestPhone } from '../realtime/test-phone.js';
import { fixtures } from '../test-fixtures.js';
import { click, renderApp, settle } from '../test-render.js';
import type { RenderedApp } from '../test-render.js';
import { TAP_GUARD_MS, countdown, summaryLine } from './approval.js';

const AGENT = 'agent-1';
const ID = '0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const OTHER = '0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c';

let mounted: RenderedApp | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

function approval(id: string, change: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id,
    sessionId: 'sess-1',
    requestHash: 'a'.repeat(64),
    toolLabel: 'Run a command',
    toolName: 'Bash',
    content: 'npm test -- --watch=false',
    truncated: false,
    suggestions: [],
    expiresAt: 0,
    alwaysSupported: false,
    ...change,
  };
}

const machine: MachineView = {
  deviceId: AGENT,
  name: 'Studio Mac',
  online: true,
  lastSeen: null,
  session: 'open',
  machine: null,
  sessions: [],
};

function view(test: TestPhone, id: string, change: Partial<RequestView> = {}): RequestView {
  return {
    machineId: AGENT,
    request: approval(id),
    deadline: test.timer.now() + 120_000,
    status: 'pending',
    ...change,
  };
}

async function open(path: string, requests: (test: TestPhone) => RequestView[]) {
  const test = createTestPhone();
  vi.spyOn(test.phone, 'connect').mockResolvedValue();
  const decide = vi.spyOn(test.phone, 'decide');
  test.phone.realtime.setState({
    connection: 'open',
    machines: { [AGENT]: machine },
    requests: Object.fromEntries(requests(test).map((v) => [v.request.id, v])),
  });
  mounted = await renderApp(path, fixtures.onboarded, { phone: test.phone });
  return { test, decide, app: mounted };
}

const text = () => mounted?.container.textContent ?? '';
const set = (test: TestPhone, change: Partial<RequestView>, id = ID) => {
  act(() => {
    const current = test.phone.realtime.getState().requests[id]!;
    test.phone.realtime.setState({
      requests: { ...test.phone.realtime.getState().requests, [id]: { ...current, ...change } },
    });
  });
};
const tick = (test: TestPhone, ms: number) => {
  act(() => {
    test.timer.advance(ms);
  });
};

describe('approval card helpers', () => {
  it('summarises the first line and formats the countdown', () => {
    expect(summaryLine('ls -la')).toBe('ls -la');
    expect(summaryLine('first\nsecond')).toBe('first…');
    expect(summaryLine('x'.repeat(80))).toBe(`${'x'.repeat(60)}…`);
    expect(countdown(125_000)).toBe('2:05');
    expect(countdown(1)).toBe('0:01');
    expect(countdown(-5)).toBe('0:00');
  });
});

describe('approval card', () => {
  it('shows the machine, the tool, the argument and the countdown', async () => {
    const { test } = await open(`/requests/${ID}`, (t) => [view(t, ID)]);
    expect(text()).toContain('Studio Mac');
    expect(mounted?.container.querySelector('h2')?.textContent).toBe('Run a command');
    expect(text()).toContain('npm test -- --watch=false');
    expect(text()).toContain('Time left: 2:00');
    tick(test, 1000);
    expect(text()).toContain('Time left: 1:59');
  });

  it('reveals the full content behind "Show details"', async () => {
    await open(`/requests/${ID}`, (t) => [
      view(t, ID, { request: approval(ID, { content: 'line one\nline two' }) }),
    ]);
    expect(mounted?.container.querySelector('pre.details')).toBeNull();
    await click(mounted!.button('Show details'));
    expect(mounted?.container.querySelector('pre.details')?.textContent).toBe(
      'Bash\nline one\nline two',
    );
    await click(mounted!.button('Hide details'));
    expect(mounted?.container.querySelector('pre.details')).toBeNull();
  });

  it('names an unknown computer', async () => {
    await open(`/requests/${ID}`, (t) => [view(t, ID, { machineId: 'gone' })]);
    expect(text()).toContain('Unknown computer');
  });

  it('disables Allow when the content was truncated', async () => {
    await open(`/requests/${ID}`, (t) => [
      view(t, ID, { request: approval(ID, { truncated: true }) }),
    ]);
    expect(mounted!.button('Allow').disabled).toBe(true);
    expect(mounted!.button('Deny').disabled).toBe(false);
    expect(text()).toContain('too long to show in full');
  });

  it('ignores taps right after the card appears', async () => {
    const { test, decide } = await open(`/requests/${ID}`, (t) => [view(t, ID)]);
    await click(mounted!.button('Allow'));
    expect(decide).not.toHaveBeenCalled();
    tick(test, TAP_GUARD_MS);
    decide.mockResolvedValue({ ok: true, decisionHash: 'h', asserted: true });
    await click(mounted!.button('Allow'));
    expect(decide).toHaveBeenCalledWith(AGENT, expect.objectContaining({ id: ID }), 'allow');
  });

  it.each([
    ['allow', 'Allow', 'Allow sent. Waiting for your computer…'],
    ['deny', 'Deny', 'Deny sent. Waiting for your computer…'],
  ] as const)('sends %s and waits for the computer', async (kind, label, waiting) => {
    const { test, decide } = await open(`/requests/${ID}`, (t) => [view(t, ID)]);
    tick(test, TAP_GUARD_MS);
    let finish: (value: { ok: true; decisionHash: string; asserted: boolean }) => void = () =>
      undefined;
    decide.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await click(mounted!.button(label));
    expect(mounted!.button('Allow').disabled).toBe(true);
    expect(mounted!.button('Deny').disabled).toBe(true);
    await click(mounted!.button(label));
    expect(decide).toHaveBeenCalledOnce();
    expect(decide).toHaveBeenCalledWith(AGENT, expect.anything(), kind);
    await act(async () => {
      finish({ ok: true, decisionHash: 'h', asserted: kind === 'allow' });
      await Promise.resolve();
    });
    await settle();
    expect(text()).toContain(waiting);
    expect(() => mounted!.button('Allow')).toThrow();
  });

  it.each([
    ['cancelled', 'Face ID was cancelled. Nothing was sent.'],
    ['offline', 'You are offline. Nothing was sent.'],
    ['rate_limited', 'Too many attempts.'],
    ['challenge_mismatch', 'Could not confirm with your passkey.'],
  ] as const)('explains a %s failure and lets the user retry', async (failure, message) => {
    const { test, decide } = await open(`/requests/${ID}`, (t) => [view(t, ID)]);
    tick(test, TAP_GUARD_MS);
    decide.mockResolvedValue({ ok: false, failure });
    await click(mounted!.button('Allow'));
    expect(mounted?.container.querySelector('.notice.error')?.textContent).toContain(message);
    expect(mounted!.button('Allow').disabled).toBe(false);
  });

  it('expires locally when the countdown runs out', async () => {
    const { test } = await open(`/requests/${ID}`, (t) => [
      view(t, ID, { deadline: t.timer.now() + 1500 }),
    ]);
    tick(test, 1000);
    expect(text()).toContain('Time left: 0:01');
    tick(test, 500);
    expect(text()).toContain('Expired. The terminal is asking again.');
    expect(() => mounted!.button('Allow')).toThrow();
  });

  it.each<[string, Partial<RequestView>, string]>([
    ['allowed', { status: 'resolved', outcome: 'allow' }, 'Allowed.'],
    ['denied', { status: 'resolved', outcome: 'deny' }, 'Denied.'],
    ['answered in the terminal', { status: 'resolved', outcome: 'terminal' }, 'terminal.'],
    ['withdrawn', { status: 'resolved', outcome: 'withdrawn' }, 'no longer needs'],
    ['expired by the agent', { status: 'expired' }, 'Expired.'],
    ['refused by the relay', { relayError: 'unverified' }, 'The relay refused'],
    [
      'already answered',
      {
        result: {
          t: 'decision_result',
          requestId: ID,
          result: 'rejected',
          reason: 'already_resolved',
        },
      },
      'Already answered elsewhere.',
    ],
    [
      'rejected for another reason',
      {
        result: {
          t: 'decision_result',
          requestId: ID,
          result: 'rejected',
          reason: 'hash_mismatch',
        },
      },
      'Your computer refused the decision.',
    ],
  ])('shows a request %s', async (_label, change, message) => {
    const { test } = await open(`/requests/${ID}`, (t) => [view(t, ID)]);
    set(test, change);
    expect(text()).toContain(message);
    expect(() => mounted!.button('Allow')).toThrow();
    expect(text()).not.toContain('Time left');
  });

  it('keeps a reply-in-terminal placeholder until M1-03', async () => {
    await open(`/requests/${ID}`, (t) => [view(t, ID)]);
    expect(mounted!.button('Reply in terminal').disabled).toBe(true);
  });
});

describe('request screen', () => {
  it('falls back to the most urgent pending request for an unknown id', async () => {
    const { app } = await open('/requests/doorbell-1', (t) => [
      view(t, ID, { deadline: t.timer.now() + 90_000 }),
      view(t, OTHER, { deadline: t.timer.now() + 30_000 }),
    ]);
    expect(app.path()).toBe(`/requests/${OTHER}`);
  });

  it('says nothing is waiting once connected, and connecting before', async () => {
    const { test } = await open('/requests/doorbell-1', () => []);
    expect(text()).toContain('Nothing is waiting for you.');
    act(() => {
      test.phone.realtime.setState({ connection: 'reconnecting' });
    });
    expect(text()).toContain('Connecting…');
  });
});
