import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useStore } from 'zustand';

import { isSignedIn } from './auth/auth-store.js';
import type { AuthState, AuthStore } from './auth/auth-store.js';
import type { RelayApi } from './auth/relay-api.js';
import type { NotificationPermissionState, OnboardingState } from './onboarding.js';

/** Side effects the onboarding screens trigger; injected so tests stay in jsdom. */
export interface PlatformActions {
  /** Must run inside the tap handler: iOS grants permission only to a user gesture. */
  readonly requestNotificationPermission: () => Promise<NotificationPermissionState>;
}

export interface AppStateValue {
  readonly state: OnboardingState;
  readonly auth: AuthStore;
  readonly relay: RelayApi;
  readonly skipInstall: () => void;
  readonly requestNotifications: () => Promise<void>;
}

const AppStateContext = createContext<AppStateValue | undefined>(undefined);

export interface AppStateProviderProps {
  /** Everything but `signedIn`, which the auth store owns. */
  readonly initialState: Omit<OnboardingState, 'signedIn'>;
  readonly platform: PlatformActions;
  readonly auth: AuthStore;
  readonly relay: RelayApi;
  readonly children: ReactNode;
}

/**
 * Holds the onboarding state for the screens. `signedIn` comes from the auth store
 * (M0-19); M0-20 (pairing) moves `paired` into its store, until then it starts false.
 */
export function AppStateProvider({
  initialState,
  platform,
  auth,
  relay,
  children,
}: AppStateProviderProps) {
  const [device, setState] = useState(initialState);
  const signedIn = useStore(auth, isSignedIn);
  const state = useMemo(() => ({ ...device, signedIn }), [device, signedIn]);
  const skipInstall = useCallback(() => {
    setState((s) => ({ ...s, installSkipped: true }));
  }, []);
  const requestNotifications = useCallback(async () => {
    const notificationPermission = await platform.requestNotificationPermission();
    setState((s) => ({ ...s, notificationPermission }));
  }, [platform]);
  const value = useMemo(
    () => ({ state, auth, relay, skipInstall, requestNotifications }),
    [state, auth, relay, skipInstall, requestNotifications],
  );
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateValue {
  const value = useContext(AppStateContext);
  if (value === undefined) throw new Error('useAppState() outside <AppStateProvider>');
  return value;
}

/** A slice of the auth store; re-renders only when the slice changes. */
export function useAuth<T>(selector: (state: AuthState) => T): T {
  return useStore(useAppState().auth, selector);
}
