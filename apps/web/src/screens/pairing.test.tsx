import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OnboardingState } from '../onboarding.js';
import { PairingError } from '../realtime/phone.js';
import type { PendingPairing, PhoneService } from '../realtime/phone.js';
import { createTestPhone } from '../realtime/test-phone.js';
import { fixtures } from '../test-fixtures.js';
import { click, renderApp, settle, type } from '../test-render.js';
import type { RenderedApp } from '../test-render.js';

const firstComputer: OnboardingState = { ...fixtures.onboarded, paired: false };

let mounted: RenderedApp | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
});

async function mount(state: OnboardingState = firstComputer, phone?: PhoneService) {
  const test = phone ?? createTestPhone().phone;
  mounted = await renderApp('/onboarding/pair', state, { phone: test });
  return { app: mounted, phone: test };
}

function input(app: RenderedApp, id: string): HTMLInputElement {
  const found = app.container.querySelector<HTMLInputElement>(`#${id}`);
  if (found === null) throw new Error(`no #${id}`);
  return found;
}

function pending(overrides: Partial<PendingPairing> = {}): PendingPairing {
  return {
    agentDeviceId: 'agent-1',
    name: 'Studio Mac',
    fingerprint: 'ABCD-EFGH',
    confirm: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

describe('pair screen', () => {
  it('titles the first computer and later ones differently', async () => {
    const { app } = await mount();
    expect(app.heading()).toBe('Add your first computer');
    expect(app.container.querySelector('a.back')).toBeNull();
    app.unmount();
    const later = await mount(fixtures.onboarded);
    expect(later.app.heading()).toBe('Add a computer');
    expect(later.app.container.querySelector('a.back')?.getAttribute('href')).toBe('/machines');
  });

  it('formats the code while typing and enables Pair once complete', async () => {
    const { app } = await mount();
    const code = input(app, 'pair-code');
    await type(code, 'abcdefgh');
    expect(code.value).toBe('ABCD-EFGH');
    expect(app.button('Pair').disabled).toBe(true);
    await type(code, 'abcd efgh jkmn xyz');
    expect(code.value).toBe('ABCD-EFGH-JKMN');
    expect(app.button('Pair').disabled).toBe(false);
  });

  it('pairs, shows the fingerprint and saves on confirm', async () => {
    const test = createTestPhone().phone;
    // Like the real confirm: the saved machine reaches the realtime store.
    const confirm = vi.fn(() => {
      test.realtime.setState({
        machines: {
          'agent-1': {
            deviceId: 'agent-1',
            name: 'Studio Mac',
            online: false,
            lastSeen: null,
            session: 'handshaking',
            machine: null,
            sessions: [],
          },
        },
      });
      return Promise.resolve();
    });
    const result = pending({ confirm });
    const pair = vi.spyOn(test, 'pair').mockResolvedValue(result);
    const { app } = await mount(firstComputer, test);
    await type(input(app, 'pair-code'), 'ABCD-EFGH-JKMN');
    await click(app.button('Pair'));
    expect(pair).toHaveBeenCalledWith('ABCD-EFGH-JKMN');
    expect(app.heading()).toBe('Check the code');
    expect(app.container.querySelector('.fingerprint')?.textContent).toBe('ABCD-EFGH');
    expect(app.container.textContent).toContain('Studio Mac');
    await click(app.button('The codes match'));
    expect(confirm).toHaveBeenCalledOnce();
    expect(app.path()).toBe('/machines');
  });

  it('keeps the confirm screen when saving fails', async () => {
    const test = createTestPhone().phone;
    vi.spyOn(test, 'pair').mockResolvedValue(
      pending({ confirm: () => Promise.reject(new Error('quota')) }),
    );
    const { app } = await mount(firstComputer, test);
    await type(input(app, 'pair-code'), 'ABCD-EFGH-JKMN');
    await click(app.button('Pair'));
    await click(app.button('The codes match'));
    expect(app.container.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not save the pairing',
    );
    expect(app.button('The codes match').disabled).toBe(false);
  });

  it('cancels back to code entry', async () => {
    const test = createTestPhone().phone;
    const confirm = vi.fn(() => Promise.resolve());
    vi.spyOn(test, 'pair').mockResolvedValue(pending({ confirm }));
    const { app } = await mount(firstComputer, test);
    await type(input(app, 'pair-code'), 'ABCD-EFGH-JKMN');
    await click(app.button('Pair'));
    await click(app.button('Cancel'));
    expect(confirm).not.toHaveBeenCalled();
    expect(app.heading()).toBe('Add your first computer');
    expect(app.container.textContent).toContain('Pairing cancelled');
  });

  it.each([
    [
      new PairingError('That code has expired. Run `npx remotectl pair` again.'),
      'That code has expired',
    ],
    [new Error('boom'), 'Pairing failed. Try again.'],
  ])('shows why pairing failed: %s', async (error, message) => {
    const test = createTestPhone().phone;
    vi.spyOn(test, 'pair').mockRejectedValue(error);
    const { app } = await mount(firstComputer, test);
    await type(input(app, 'pair-code'), 'ABCD-EFGH-JKMN');
    await click(app.button('Pair'));
    expect(app.container.querySelector('[role="alert"]')?.textContent).toContain(message);
    expect(app.button('Pair').disabled).toBe(false);
  });

  it('shows the wait while the computer answers', async () => {
    const test = createTestPhone().phone;
    vi.spyOn(test, 'pair').mockReturnValue(new Promise(() => undefined));
    const { app } = await mount(firstComputer, test);
    await type(input(app, 'pair-code'), 'ABCD-EFGH-JKMN');
    await click(app.button('Pair'));
    expect(app.container.textContent).toContain('Waiting for your computer');
    expect(app.button('Pair').disabled).toBe(true);
  });

  it('creates the login command for a new computer', async () => {
    const test = createTestPhone().phone;
    const enroll = vi
      .spyOn(test, 'enroll')
      .mockResolvedValue({ deviceId: 'agent-1', enrollToken: 'rc-enroll:abc' });
    const { app } = await mount(firstComputer, test);
    const button = app.button('Get the login command');
    expect(button.disabled).toBe(true);
    await type(input(app, 'enrol-name'), '  Studio Mac ');
    await click(button);
    expect(enroll).toHaveBeenCalledWith('Studio Mac');
    expect(app.container.textContent).toContain('npx remotectl login rc-enroll:abc');
  });

  it('explains a failed enrolment', async () => {
    const test = createTestPhone().phone;
    vi.spyOn(test, 'enroll').mockRejectedValue(new Error('500'));
    const { app } = await mount(firstComputer, test);
    await type(input(app, 'enrol-name'), 'Studio Mac');
    await click(app.button('Get the login command'));
    expect(app.container.querySelector('[role="alert"]')?.textContent).toBe(
      'Could not create the login command. Try again.',
    );
  });

  it('disables pairing while offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const { app } = await mount();
    await act(async () => {
      window.dispatchEvent(new Event('offline'));
      await Promise.resolve();
    });
    await type(input(app, 'pair-code'), 'ABCD-EFGH-JKMN');
    await type(input(app, 'enrol-name'), 'Studio Mac');
    await settle();
    expect(app.container.textContent).toContain('You are offline — pairing needs a connection.');
    expect(app.button('Pair').disabled).toBe(true);
    expect(app.button('Get the login command').disabled).toBe(true);
  });
});
