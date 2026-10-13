import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { BrowserRouter } from 'react-router';

import { AppStateProvider } from './app-state.js';
import { createAuthStore } from './auth/auth-store.js';
import type { SessionHint } from './auth/auth-store.js';
import type { PasskeyKeys } from './auth/passkey-keys.js';
import type { RelayApi } from './auth/relay-api.js';
import type { PlatformActions } from './app-state.js';
import { probeCapabilities } from './capabilities.js';
import type { BrowserEnvironment, WebCryptoCheck } from './capabilities.js';
import type { InstallChoice, NotificationPermissionState } from './onboarding.js';
import type { QrScanner } from './pairing/qr-scanner.js';
import type { MediaQuery } from './ports/media-query.js';
import type { NavigationSource } from './push/navigation.js';
import { registerPush } from './push/push-subscription.js';
import type { PushManagerLike } from './push/push-subscription.js';
import type { PhoneService } from './realtime/phone.js';
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

/** The slice of `ServiceWorkerContainer` the app uses. */
export interface ServiceWorkerApi extends NavigationSource {
  readonly ready: Promise<{ readonly pushManager: PushManagerLike }>;
}

/** The Badging API on `navigator`; missing where the platform has no badge. */
export interface BadgeApi {
  readonly setAppBadge?: (count: number) => Promise<void>;
  readonly clearAppBadge?: () => Promise<void>;
}

export interface PlatformApis {
  readonly relay: Pick<RelayApi, 'pushKey' | 'savePushSubscription'>;
  readonly serviceWorker?: ServiceWorkerApi;
  readonly badge?: BadgeApi;
  readonly qrScanner?: QrScanner;
  readonly installChoice?: InstallChoice;
  readonly wideLayout?: MediaQuery;
}

export function createPlatformActions(
  api: NotificationApi | undefined,
  { relay, serviceWorker, badge, qrScanner, installChoice, wideLayout }: PlatformApis,
): PlatformActions {
  return {
    ...(qrScanner && { qrScanner }),
    ...(wideLayout && { wideLayout }),
    ...(installChoice && { rememberInstallSkip: () => installChoice.skip() }),
    requestNotificationPermission: async () => {
      if (api === undefined) return 'unsupported';
      return api.requestPermission();
    },
    ...(serviceWorker && {
      serviceWorker,
      registerPush: async () => registerPush((await serviceWorker.ready).pushManager, relay),
    }),
    setBadge: (count) => {
      // The badge is a hint: a refusal (e.g. no notification permission) changes nothing.
      const pending = count > 0 ? badge?.setAppBadge?.(count) : badge?.clearAppBadge?.();
      pending?.catch(() => undefined);
    },
  };
}

export interface BootstrapOptions {
  readonly container: Element;
  readonly env: BrowserEnvironment;
  readonly notifications: NotificationApi | undefined;
  readonly serviceWorker?: ServiceWorkerApi;
  readonly badge?: BadgeApi;
  readonly qrScanner?: QrScanner;
  readonly relay: RelayApi;
  readonly phone: PhoneService;
  readonly hint?: SessionHint;
  /** Where registration keeps the passkey public keys pairing hands over (M2-03). */
  readonly passkeys?: PasskeyKeys;
  readonly checkWebCrypto?: WebCryptoCheck;
  readonly installChoice?: InstallChoice;
  readonly wideLayout?: MediaQuery;
}

/** Probes the platform and the session, then mounts the app. */
export async function bootstrap(options: BootstrapOptions): Promise<Root> {
  const { relay } = options;
  const auth = createAuthStore({
    api: relay,
    ...(options.hint && { hint: options.hint }),
    ...(options.passkeys && { passkeys: options.passkeys }),
  });
  const [capabilities, , pairedCount] = await Promise.all([
    probeCapabilities(options.env, options.checkWebCrypto),
    // Known before the first render, so a signed-in user never sees the passkey step.
    auth.getState().checkSession(),
    // A phone without a usable key store cannot pair either: onboarding stops at that step.
    options.phone.pairedCount().catch(() => 0),
  ]);
  const initialState = {
    capabilities,
    installSkipped: options.installChoice?.read() ?? false,
    notificationPermission: readNotificationPermission(options.notifications),
    paired: pairedCount > 0,
  };
  const root = createRoot(options.container);
  root.render(
    <StrictMode>
      <BrowserRouter>
        <AppStateProvider
          initialState={initialState}
          platform={createPlatformActions(options.notifications, {
            relay,
            ...(options.serviceWorker && { serviceWorker: options.serviceWorker }),
            ...(options.badge && { badge: options.badge }),
            ...(options.qrScanner && { qrScanner: options.qrScanner }),
            ...(options.installChoice && { installChoice: options.installChoice }),
            ...(options.wideLayout && { wideLayout: options.wideLayout }),
          })}
          auth={auth}
          relay={relay}
          phone={options.phone}
        >
          <AppRoutes />
        </AppStateProvider>
      </BrowserRouter>
    </StrictMode>,
  );
  return root;
}
