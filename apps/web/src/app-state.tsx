import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useStore } from 'zustand';

import { isSignedIn } from './auth/auth-store.js';
import type { AuthState, AuthStore } from './auth/auth-store.js';
import type { RelayApi } from './auth/relay-api.js';
import type { NotificationPermissionState, OnboardingState } from './onboarding.js';
import type { PhoneService } from './realtime/phone.js';
import type { RealtimeState } from './realtime/realtime-store.js';

/** Side effects the onboarding screens trigger; injected so tests stay in jsdom. */
export interface PlatformActions {
  /** Must run inside the tap handler: iOS grants permission only to a user gesture. */
  readonly requestNotificationPermission: () => Promise<NotificationPermissionState>;
}

export interface AppStateValue {
  readonly state: OnboardingState;
  readonly auth: AuthStore;
  readonly relay: RelayApi;
  readonly phone: PhoneService;
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
  readonly phone: PhoneService;
  readonly children: ReactNode;
}

const signedInUser = (state: AuthState): string | null =>
  state.status === 'signed-in' ? state.userId : null;
const hasMachines = (state: RealtimeState): boolean => Object.keys(state.machines).length > 0;

/**
 * Holds the onboarding state for the screens. `signedIn` comes from the auth store
 * (M0-19); `paired` is the key store's count at start-up, then the realtime store's
 * machines (M0-20). The phone is connected exactly while a user is signed in.
 */
export function AppStateProvider({
  initialState,
  platform,
  auth,
  relay,
  phone,
  children,
}: AppStateProviderProps) {
  const [device, setState] = useState(initialState);
  const signedIn = useStore(auth, isSignedIn);
  const userId = useStore(auth, signedInUser);
  const machines = useStore(phone.realtime, hasMachines);
  useEffect(() => {
    if (userId === null) {
      phone.disconnect();
      return;
    }
    // A failure (e.g. offline) is retried when the app wakes up; see `PhoneService.wake`.
    phone.connect(userId).catch(() => undefined);
  }, [phone, userId]);
  const state = useMemo(
    () => ({ ...device, signedIn, paired: device.paired || machines }),
    [device, signedIn, machines],
  );
  const skipInstall = useCallback(() => {
    setState((s) => ({ ...s, installSkipped: true }));
  }, []);
  const requestNotifications = useCallback(async () => {
    const notificationPermission = await platform.requestNotificationPermission();
    setState((s) => ({ ...s, notificationPermission }));
  }, [platform]);
  const value = useMemo(
    () => ({ state, auth, relay, phone, skipInstall, requestNotifications }),
    [state, auth, relay, phone, skipInstall, requestNotifications],
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
