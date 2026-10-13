import { describe, expect, it } from 'vitest';

import { evaluateCapabilities } from './capabilities.js';
import type { CapabilityFacts } from './capabilities.js';
import { nextOnboardingStep, onboardingRedirect, storageInstallChoice } from './onboarding.js';
import type { OnboardingState, OnboardingStep } from './onboarding.js';
import { fixtures } from './test-fixtures.js';

const { iosTab, iosInstalled, androidTab, android, oldBrowser } = fixtures.capabilities;

function state(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return {
    capabilities: androidTab,
    signedIn: false,
    installSkipped: false,
    notificationPermission: 'default',
    paired: false,
    ...overrides,
  };
}

describe('nextOnboardingStep', () => {
  it.each<[string, OnboardingState, OnboardingStep]>([
    ['unsupported browser', state({ capabilities: oldBrowser, signedIn: true }), 'update-browser'],
    ['not signed in', state(), 'passkey'],
    ['iOS tab, signed in', state({ capabilities: iosTab, signedIn: true }), 'install'],
    [
      'iOS tab cannot skip the install',
      state({ capabilities: iosTab, signedIn: true, installSkipped: true }),
      'install',
    ],
    ['Android tab, signed in', state({ signedIn: true }), 'install'],
    [
      'Android tab, install skipped',
      state({ signedIn: true, installSkipped: true }),
      'notifications',
    ],
    [
      'installed, permission default',
      state({ capabilities: android, signedIn: true }),
      'notifications',
    ],
    [
      'installed, permission denied',
      state({ capabilities: iosInstalled, signedIn: true, notificationPermission: 'denied' }),
      'notifications',
    ],
    [
      'installed, permission granted',
      state({ capabilities: iosInstalled, signedIn: true, notificationPermission: 'granted' }),
      'pair',
    ],
    [
      'everything done',
      state({
        capabilities: iosInstalled,
        signedIn: true,
        notificationPermission: 'granted',
        paired: true,
      }),
      'done',
    ],
  ])('%s → %s', (_name, input, expected) => {
    expect(nextOnboardingStep(input)).toBe(expected);
  });

  it('follows the order passkey → install → notifications → pair', () => {
    const steps: OnboardingStep[] = [];
    let current = state({ capabilities: iosTab });
    for (;;) {
      const step = nextOnboardingStep(current);
      steps.push(step);
      if (step === 'done') break;
      if (step === 'passkey') current = { ...current, signedIn: true };
      if (step === 'install') {
        const facts: CapabilityFacts = { ...current.capabilities, standalone: true, push: true };
        current = { ...current, capabilities: evaluateCapabilities(facts) };
      }
      if (step === 'notifications') current = { ...current, notificationPermission: 'granted' };
      if (step === 'pair') current = { ...current, paired: true };
    }
    expect(steps).toEqual(['passkey', 'install', 'notifications', 'pair', 'done']);
  });
});

describe('onboardingRedirect', () => {
  it('returns the route of the current step', () => {
    expect(onboardingRedirect(state())).toBe('/onboarding/passkey');
  });

  it('returns undefined once onboarding is complete', () => {
    expect(onboardingRedirect(fixtures.onboarded)).toBeUndefined();
  });
});

describe('storageInstallChoice', () => {
  it('remembers that the install step was skipped', () => {
    window.localStorage.clear();
    const choice = storageInstallChoice(() => window.localStorage);
    expect(choice.read()).toBe(false);
    choice.skip();
    expect(storageInstallChoice(() => window.localStorage).read()).toBe(true);
    window.localStorage.clear();
  });

  it('is a no-op without storage', () => {
    const choice = storageInstallChoice(() => undefined);
    choice.skip();
    expect(choice.read()).toBe(false);
  });

  it('swallows storage that throws', () => {
    const choice = storageInstallChoice(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(() => {
      choice.skip();
    }).not.toThrow();
    expect(choice.read()).toBe(false);
  });
});
