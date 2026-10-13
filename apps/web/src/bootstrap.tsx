import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { BrowserRouter } from 'react-router';

import { AppStateProvider } from './app-state.js';
import { createAuthStore } from './auth/auth-store.js';
import type { SessionHint } from './auth/auth-store.js';
import type { RelayApi } from './auth/relay-api.js';
import type { PlatformActions } from './app-state.js';
import { probeCapabilities } from './capabilities.js';
import type { BrowserEnvironment, WebCryptoCheck } from './capabilities.js';
import type { NotificationPermissionState } from './onboarding.js';
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
  readonly relay: RelayApi;
  readonly hint?: SessionHint;
  readonly checkWebCrypto?: WebCryptoCheck;
}

/** Probes the platform and the session, then mounts the app. */
export async function bootstrap(options: BootstrapOptions): Promise<Root> {
  const { relay } = options;
  const auth = createAuthStore({ api: relay, ...(options.hint && { hint: options.hint }) });
  const [capabilities] = await Promise.all([
    probeCapabilities(options.env, options.checkWebCrypto),
    // Known before the first render, so a signed-in user never sees the passkey step.
    auth.getState().checkSession(),
  ]);
  const initialState = {
    capabilities,
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
          auth={auth}
          relay={relay}
        >
          <AppRoutes />
        </AppStateProvider>
      </BrowserRouter>
    </StrictMode>,
  );
  return root;
}
