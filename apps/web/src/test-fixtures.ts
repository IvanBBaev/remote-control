import { evaluateCapabilities } from './capabilities.js';
import type { OnboardingState } from './onboarding.js';

/** Typical platforms, for tests. */
const capabilities = {
  /** iOS Safari in a tab: no push until installed. */
  iosTab: evaluateCapabilities({ standalone: false, push: false, webAuthn: true, webCrypto: true }),
  iosInstalled: evaluateCapabilities({
    standalone: true,
    push: true,
    webAuthn: true,
    webCrypto: true,
  }),
  /** Android Chrome in a tab: push already works, installing is optional. */
  androidTab: evaluateCapabilities({
    standalone: false,
    push: true,
    webAuthn: true,
    webCrypto: true,
  }),
  android: evaluateCapabilities({ standalone: true, push: true, webAuthn: true, webCrypto: true }),
  oldBrowser: evaluateCapabilities({
    standalone: false,
    push: true,
    webAuthn: false,
    webCrypto: false,
  }),
};

const onboarded: OnboardingState = {
  capabilities: capabilities.iosInstalled,
  signedIn: true,
  installSkipped: false,
  notificationPermission: 'granted',
  paired: true,
};

export const fixtures = { capabilities, onboarded };
