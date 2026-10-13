import type { DecisionResultMessage, Repository, Session } from '@remote-control/protocol';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommandResult } from '../realtime/phone.js';
import type { CommandView, MachineView } from '../realtime/realtime-store.js';
import { createTestPhone } from '../realtime/test-phone.js';
import type { TestPhone } from '../realtime/test-phone.js';
import { fixtures } from '../test-fixtures.js';
import { click, renderApp, settle } from '../test-render.js';
import type { RenderedApp } from '../test-render.js';
import { commandText } from './request-status.js';

const MAC = 'agent-mac';
const LAPTOP = 'agent-laptop';
const RID = '0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';

let mounted: RenderedApp | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

const repository = (machineId: string, name: string): Repository => ({
  id: `${machineId}-${name}`,
  machineId,
  name,
  path: `/Users/me/code/${name}`,
});

function session(change: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    machineId: MAC,
    repositoryId: null,
    agent: 'claude-code',
    state: 'idle',
    statusText: 'Waiting for you',
    lastPrompt: null,
    lastAnswer: null,
    steps: [],
    changedFiles: [],
    ...change,
  };
}

function machine(
  deviceId: string,
  name: string,
  online: boolean,
  change: Partial<MachineView> = {},
): MachineView {
  return {
    deviceId,
    name,
    online,
    lastSeen: null,
    session: online ? 'open' : 'none',
    machine: null,
    sessions: [],
    history: null,
    repositories: [],
    ...change,
  };
}

async function open(path: string, machines: MachineView[]) {
  const test = createTestPhone();
  vi.spyOn(test.phone, 'connect').mockResolvedValue();
  const start = vi.spyOn(test.phone, 'start');
  const instruct = vi.spyOn(test.phone, 'instruct');
  test.phone.realtime.setState({
    connection: 'open',
    machines: Object.fromEntries(machines.map((m) => [m.deviceId, m])),
  });
  mounted = await renderApp(path, fixtures.onboarded, { phone: test.phone });
  return { test, start, instruct, app: mounted };
}

const text = () => mounted?.container.textContent ?? '';
const query = <T extends Element>(selector: string) =>
  mounted?.container.querySelector<T>(selector) ?? null;
const button = (label: string) =>
  [...(mounted?.container.querySelectorAll('button') ?? [])].find(
    (candidate) => candidate.textContent === label,
  ) as HTMLButtonElement;

async function write(selector: string, value: string): Promise<void> {
  const area = query<HTMLTextAreaElement>(selector)!;
  await act(async () => {
    Reflect.set(HTMLTextAreaElement.prototype, 'value', value, area);
    area.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

const accepted = (requestId: string): CommandResult => ({
  ok: true,
  decisionHash: 'h',
  asserted: true,
  requestId,
});

/** What the realtime client stores for a sent command, then the agent's answer. */
function track(test: TestPhone, view: CommandView, id = RID): void {
  act(() => {
    test.phone.realtime.setState((state) => ({ commands: { ...state.commands, [id]: view } }));
  });
}
function answer(test: TestPhone, change: Partial<CommandView>, id = RID): void {
  act(() => {
    test.phone.realtime.setState((state) => ({
      commands: { ...state.commands, [id]: { ...state.commands[id]!, ...change } },
    }));
  });
}

describe('new session screen (M1-04)', () => {
  it('asks for a pairing when there is no computer', async () => {
    await open('/new', []);
    expect(text()).toContain('Pair a computer first.');
    expect(query('a.button')?.getAttribute('href')).toBe('/onboarding/pair');
  });

  it('picks the first online computer and lists its folders by name, the path on tap', async () => {
    await open('/new', [
      machine(LAPTOP, 'A laptop', false),
      machine(MAC, 'Studio Mac', true, {
        repositories: [repository(MAC, 'api'), repository(MAC, 'web')],
      }),
    ]);
    const select = query<HTMLSelectElement>('#new-machine')!;
    expect(select.value).toBe(MAC);
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'A laptop (offline)',
      'Studio Mac',
    ]);
    expect(
      [...mounted!.container.querySelectorAll('.project-name')].map((n) => n.textContent),
    ).toEqual(['api', 'web']);
    expect(text()).not.toContain('/Users/me/code/api');
    const reveal = button('Show path');
    expect(reveal.getAttribute('aria-label')).toBe('Show the path of api');
    await click(reveal);
    expect(query('code.details')?.textContent).toBe('/Users/me/code/api');
    expect(reveal.getAttribute('aria-expanded')).toBe('true');
    await click(button('Hide path'));
    expect(query('code.details')).toBeNull();
  });

  it('keeps Start off while offline, without folders or without a prompt', async () => {
    await open('/new', [
      machine(MAC, 'Studio Mac', true),
      machine(LAPTOP, 'Work laptop', false, { repositories: [repository(LAPTOP, 'api')] }),
    ]);
    expect(text()).toContain('No folders are allowed on this computer yet.');
    await write('#new-prompt', 'Fix the tests');
    expect(button('Start').disabled).toBe(true);

    const select = query<HTMLSelectElement>('#new-machine')!;
    await act(async () => {
      select.value = LAPTOP;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(text()).toContain('Offline. Start is available when the computer is online.');
    expect(button('Start').disabled).toBe(true);
  });

  it('starts with the picked folder and follows the result to the new session', async () => {
    const api = repository(MAC, 'api');
    const web = repository(MAC, 'web');
    const { test, start } = await open('/new', [
      machine(MAC, 'Studio Mac', true, { repositories: [api, web] }),
    ]);
    start.mockResolvedValue(accepted(RID));
    expect(button('Start').disabled).toBe(true);
    await write('#new-prompt', '   ');
    expect(button('Start').disabled).toBe(true);
    await click(mounted!.container.querySelectorAll<HTMLInputElement>('input[type=radio]')[1]!);
    await write('#new-prompt', '  Fix the tests ');
    track(test, { machineId: MAC, kind: 'start', target: web.id, text: 'Fix the tests' });
    await click(button('Start'));
    expect(start).toHaveBeenCalledWith(MAC, web, 'Fix the tests');
    expect(text()).toContain('Sent. Waiting for your computer…');
    expect(button('Start').disabled).toBe(true);

    const result: DecisionResultMessage = {
      t: 'decision_result',
      requestId: RID,
      result: 'accepted',
      sessionId: 'sess/9',
    };
    answer(test, { result });
    expect(text()).toContain('Session started.');
    const link = [...mounted!.container.querySelectorAll('a')].find(
      (a) => a.textContent === 'Open the session',
    );
    expect(link?.getAttribute('href')).toBe('/sessions/sess%2F9');
  });

  it.each([
    ['not_allowed', "That folder is not on your computer's allow-list."],
    ['start_failed', 'The computer did not start the session.'],
    ['unsupported', "Your computer's remotectl cannot do this yet."],
  ] as const)('shows the %s rejection', async (reason, shown) => {
    const { test, start } = await open('/new', [
      machine(MAC, 'Studio Mac', true, { repositories: [repository(MAC, 'api')] }),
    ]);
    start.mockResolvedValue(accepted(RID));
    track(test, { machineId: MAC, kind: 'start', target: `${MAC}-api`, text: 'Go' });
    await write('#new-prompt', 'Go');
    await click(button('Start'));
    answer(test, { result: { t: 'decision_result', requestId: RID, result: 'rejected', reason } });
    expect(query('p.notice.error')?.textContent).toContain(shown);
    // Answered: Start works again.
    expect(button('Start').disabled).toBe(false);
  });

  it('shows why the passkey step failed and sends nothing else', async () => {
    const { start } = await open('/new', [
      machine(MAC, 'Studio Mac', true, { repositories: [repository(MAC, 'api')] }),
    ]);
    start.mockResolvedValue({ ok: false, failure: 'cancelled', requestId: RID });
    await write('#new-prompt', 'Go');
    await click(button('Start'));
    expect(query('p.notice.error')).not.toBeNull();
    expect(text()).not.toContain('Waiting for your computer');
    expect(start).toHaveBeenCalledOnce();
  });
});

describe('session compose box (M1-04)', () => {
  it('shows the session and sends a follow-up when it takes one', async () => {
    const live = session({ name: 'fix-tests', followUp: true, state: 'working' });
    const { test, instruct } = await open('/sessions/sess-1', [
      machine(MAC, 'Studio Mac', true, { sessions: [live] }),
    ]);
    expect(mounted!.heading()).toBe('fix-tests');
    expect(text()).toContain('working · Waiting for you');
    instruct.mockResolvedValue(accepted(RID));
    const area = query<HTMLTextAreaElement>('#compose-text')!;
    expect(area.disabled).toBe(false);
    expect(button('Send').disabled).toBe(true);
    await write('#compose-text', ' Now run lint ');
    track(test, { machineId: MAC, kind: 'instruct', target: 'sess-1', text: 'Now run lint' });
    await click(button('Send'));
    expect(instruct).toHaveBeenCalledWith(MAC, 'sess-1', 'Now run lint');
    expect(area.value).toBe('');
    answer(test, { result: { t: 'decision_result', requestId: RID, result: 'accepted' } });
    expect(text()).toContain('Sent to the session.');
    expect(text()).not.toContain('Open the session');

    answer(test, {
      result: {
        t: 'decision_result',
        requestId: RID,
        result: 'rejected',
        reason: 'follow_up_unsupported',
      },
    });
    expect(text()).toContain('This session cannot take instructions from the phone.');
  });

  it.each([
    [{ followUp: false }, true, 'This session runs in a terminal. Continue it there.'],
    [{}, true, 'This session runs in a terminal. Continue it there.'],
    [{ followUp: true, state: 'ended' as const }, true, 'This session has ended.'],
    [{ followUp: true }, false, 'Offline.'],
  ])('disables the box with the reason for %o (online %s)', async (change, online, reason) => {
    await open('/sessions/sess-1', [
      machine(MAC, 'Studio Mac', online, { sessions: [session(change)] }),
    ]);
    expect(mounted!.heading()).toBe('Session');
    expect(query<HTMLTextAreaElement>('#compose-text')?.disabled).toBe(true);
    expect(button('Send').disabled).toBe(true);
    expect(text()).toContain(reason);
  });

  it('says when the session is gone or the phone is still connecting', async () => {
    const { test } = await open('/sessions/sess-404', [machine(MAC, 'Studio Mac', true)]);
    expect(text()).toContain('This session no longer exists.');
    act(() => {
      test.phone.realtime.setState({ connection: 'connecting' });
    });
    await settle();
    expect(text()).toContain('Connecting…');
  });
});

describe('commandText', () => {
  const view: CommandView = { machineId: MAC, kind: 'start', target: 'r', text: 'x' };
  const rejected = (reason: string) =>
    commandText({
      ...view,
      result: { t: 'decision_result', requestId: RID, result: 'rejected', reason },
    } as CommandView);

  it('names every outcome', () => {
    expect(commandText(view)).toBeUndefined();
    expect(commandText({ ...view, relayError: 'expired' })).toBe(
      'Not delivered in time. Nothing was sent.',
    );
    expect(commandText({ ...view, relayError: 'rate_limited' })).toBe(
      'The relay refused it. Try again.',
    );
    expect(rejected('too_late')).toContain('Too late');
    expect(rejected('expired')).toContain('Too late');
    expect(rejected('no_session')).toBe('Your computer lost the connection. Try again.');
    expect(rejected('hash_mismatch')).toBe('Your computer refused it.');
  });
});
