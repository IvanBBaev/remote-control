import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import type { NotificationPermissionState, OnboardingState } from './onboarding.js';

/** Side effects the onboarding screens trigger; injected so tests stay in jsdom. */
export interface PlatformActions {
  /** Must run inside the tap handler: iOS grants permission only to a user gesture. */
  readonly requestNotificationPermission: () => Promise<NotificationPermissionState>;
}

export interface AppStateValue {
  readonly state: OnboardingState;
  readonly skipInstall: () => void;
  readonly requestNotifications: () => Promise<void>;
}

const AppStateContext = createContext<AppStateValue | undefined>(undefined);

export interface AppStateProviderProps {
  readonly initialState: OnboardingState;
  readonly platform: PlatformActions;
  readonly children: ReactNode;
}

/**
 * Holds the onboarding state for the screens. M0-19 (passkeys) and M0-20 (pairing) move
 * `signedIn` and `paired` into their zustand stores; until then they start false.
 */
export function AppStateProvider({ initialState, platform, children }: AppStateProviderProps) {
  const [state, setState] = useState(initialState);
  const skipInstall = useCallback(() => {
    setState((s) => ({ ...s, installSkipped: true }));
  }, []);
  const requestNotifications = useCallback(async () => {
    const notificationPermission = await platform.requestNotificationPermission();
    setState((s) => ({ ...s, notificationPermission }));
  }, [platform]);
  const value = useMemo(
    () => ({ state, skipInstall, requestNotifications }),
    [state, skipInstall, requestNotifications],
  );
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateValue {
  const value = useContext(AppStateContext);
  if (value === undefined) throw new Error('useAppState() outside <AppStateProvider>');
  return value;
}
