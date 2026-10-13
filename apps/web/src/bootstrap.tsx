import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { BrowserRouter } from 'react-router';

import { AppStateProvider } from './app-state.js';
import type { PlatformActions } from './app-state.js';
import { probeCapabilities } from './capabilities.js';
import type { BrowserEnvironment, WebCryptoCheck } from './capabilities.js';
import type { NotificationPermissionState, OnboardingState } from './onboarding.js';
import { AppRoutes } from './routes.js';

/** The slice of the `Notification` global the app uses. */
export interface NotificationApi {
  readonly permission: NotificationPermission;
  readonly requestPermission: () => Promise<NotificationPermission>;
}

export function readNotificationPermission(
  api: NotificationApi | undefined,
): NotificationPermissionState {
  return api === undefined ? 'unsupported' : api.permission;
}

export function createPlatformActions(api: NotificationApi | undefined): PlatformActions {
  return {
    requestNotificationPermission: async () => {
      if (api === undefined) return 'unsupported';
      return api.requestPermission();
    },
  };
}

export interface BootstrapOptions {
  readonly container: Element;
  readonly env: BrowserEnvironment;
  readonly notifications: NotificationApi | undefined;
  readonly checkWebCrypto?: WebCryptoCheck;
}

/** Probes the platform, then mounts the app. */
export async function bootstrap(options: BootstrapOptions): Promise<Root> {
  const capabilities = await probeCapabilities(options.env, options.checkWebCrypto);
  const initialState: OnboardingState = {
    capabilities,
    signedIn: false,
    installSkipped: false,
    notificationPermission: readNotificationPermission(options.notifications),
    paired: false,
  };
  const root = createRoot(options.container);
  root.render(
    <StrictMode>
      <BrowserRouter>
        <AppStateProvider
          initialState={initialState}
          platform={createPlatformActions(options.notifications)}
        >
          <AppRoutes />
        </AppStateProvider>
      </BrowserRouter>
    </StrictMode>,
  );
  return root;
}
