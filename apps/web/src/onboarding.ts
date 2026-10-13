import type { CapabilityReport } from './capabilities.js';

/** `Notification.permission`, or `unsupported` when the API is absent. */
export type NotificationPermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

/** Everything the onboarding gate (05 Rec-3) decides on. */
export interface OnboardingState {
  readonly capabilities: CapabilityReport;
  /** The user holds a passkey for this relay and is signed in (M0-19 wires it). */
  readonly signedIn: boolean;
  /**
   * The user chose "Continue in the browser" on the install screen. Honoured only when
   * the browser already has push (Android Chrome, desktop): installing is optional there.
   */
  readonly installSkipped: boolean;
  readonly notificationPermission: NotificationPermissionState;
  /** At least one machine is paired with this phone (M0-20 wires it). */
  readonly paired: boolean;
}

/** Steps in gate order: passkey → install → notifications → pair. */
export type OnboardingStep =
  'update-browser' | 'passkey' | 'install' | 'notifications' | 'pair' | 'done';

export const ONBOARDING_ROUTES: Readonly<Record<Exclude<OnboardingStep, 'done'>, string>> = {
  'update-browser': '/onboarding/update-browser',
  passkey: '/onboarding/passkey',
  install: '/onboarding/install',
  notifications: '/onboarding/notifications',
  pair: '/onboarding/pair',
};

/**
 * The first unmet step. The passkey comes first because WebAuthn works in a browser
 * tab. An installed iOS app starts with its own storage, so there the user lands on the
 * passkey step again and signs in with the same passkey. Push permission is asked only
 * after the install step, from a tap (05 F1).
 */
export function nextOnboardingStep(state: OnboardingState): OnboardingStep {
  const { capabilities } = state;
  if (capabilities.verdict === 'unsupported') return 'update-browser';
  if (!state.signedIn) return 'passkey';
  if (!capabilities.standalone) {
    if (capabilities.verdict === 'install-required' || !state.installSkipped) return 'install';
  }
  if (state.notificationPermission !== 'granted') return 'notifications';
  if (!state.paired) return 'pair';
  return 'done';
}

/** Route of the first unmet step, or `undefined` when onboarding is complete. */
export function onboardingRedirect(state: OnboardingState): string | undefined {
  const step = nextOnboardingStep(state);
  return step === 'done' ? undefined : ONBOARDING_ROUTES[step];
}
