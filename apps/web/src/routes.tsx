import type { ReactElement } from 'react';
import { Navigate, Outlet, useRoutes } from 'react-router';
import type { RouteObject } from 'react-router';

import { useAppState } from './app-state.js';
import { ONBOARDING_ROUTES, nextOnboardingStep, onboardingRedirect } from './onboarding.js';
import type { OnboardingStep } from './onboarding.js';
import { AppShell, BareShell } from './screens/layout.js';
import {
  LoginScreen,
  MachinesScreen,
  NewSessionScreen,
  NotFoundScreen,
  RequestScreen,
  SessionScreen,
  SessionsScreen,
} from './screens/main.js';
import {
  InstallScreen,
  NotificationsScreen,
  PairScreen,
  PasskeyScreen,
  UpdateBrowserScreen,
} from './screens/onboarding.js';

/** Where the app lands once onboarding is complete. */
export const HOME_ROUTE = '/sessions';

function stepRoute(step: OnboardingStep): string {
  return step === 'done' ? HOME_ROUTE : ONBOARDING_ROUTES[step];
}

/** Renders a step only while it is the current one; any other step redirects there. */
function StepGuard({ step, children }: { step: OnboardingStep; children: ReactElement }) {
  const current = nextOnboardingStep(useAppState().state);
  return current === step ? children : <Navigate to={stepRoute(current)} replace />;
}

function CurrentStep() {
  return <Navigate to={stepRoute(nextOnboardingStep(useAppState().state))} replace />;
}

/** The main app is reachable only once onboarding is complete (05 Rec-3). */
function OnboardingGate() {
  const redirect = onboardingRedirect(useAppState().state);
  return redirect === undefined ? <AppShell /> : <Navigate to={redirect} replace />;
}

/** The pairing screen stays reachable after onboarding, to add more computers. */
function PairStep() {
  const current = nextOnboardingStep(useAppState().state);
  if (current === 'pair' || current === 'done') return <PairScreen />;
  return <Navigate to={stepRoute(current)} replace />;
}

export const ROUTES: RouteObject[] = [
  {
    element: <BareShell />,
    children: [
      { path: '/login', element: <LoginScreen /> },
      {
        path: '/onboarding',
        element: <Outlet />,
        children: [
          { index: true, element: <CurrentStep /> },
          {
            path: 'update-browser',
            element: (
              <StepGuard step="update-browser">
                <UpdateBrowserScreen />
              </StepGuard>
            ),
          },
          {
            path: 'passkey',
            element: (
              <StepGuard step="passkey">
                <PasskeyScreen />
              </StepGuard>
            ),
          },
          {
            path: 'install',
            element: (
              <StepGuard step="install">
                <InstallScreen />
              </StepGuard>
            ),
          },
          {
            path: 'notifications',
            element: (
              <StepGuard step="notifications">
                <NotificationsScreen />
              </StepGuard>
            ),
          },
          { path: 'pair', element: <PairStep /> },
          { path: '*', element: <CurrentStep /> },
        ],
      },
      { path: '*', element: <NotFoundScreen /> },
    ],
  },
  {
    element: <OnboardingGate />,
    children: [
      { path: '/', element: <Navigate to={HOME_ROUTE} replace /> },
      { path: '/machines', element: <MachinesScreen /> },
      { path: '/sessions', element: <SessionsScreen /> },
      { path: '/sessions/:id', element: <SessionScreen /> },
      { path: '/requests/:id', element: <RequestScreen /> },
      { path: '/new', element: <NewSessionScreen /> },
    ],
  },
];

export function AppRoutes() {
  return useRoutes(ROUTES);
}
