import { toBase64 } from '@remote-control/phone-core/realtime/envelope';
import type { RelayApi } from '@remote-control/phone-core/auth/relay-api';
import { router } from 'expo-router';
import { create } from 'zustand';

import {
  apnsDeviceToken,
  installNotificationHandler,
  onNotificationIntent,
  registerNotificationCategories,
  saveSharedNotificationKeys,
} from '../adapters/notifications';
import { createSecureKeyStore } from '../adapters/secure-key-store';
import { systemNow } from '../adapters/system-clock';
import { systemRandom } from '../adapters/system-random';
import {
  apnsEnvironment,
  type NotificationIntent,
  rawNotificationKey,
  resolveIntent,
} from '../core/notifications';
import { useInbox } from './store';

/** What the settings screen shows for push notifications. */
export type PushStatus = 'off' | 'on' | 'denied' | 'failed';

export const usePush = create<{ readonly status: PushStatus }>()(() => ({ status: 'off' }));

/** An intent waits this long for its session to arrive over the live connection. */
const INTENT_TTL_MS = 30_000;

async function registerToken(relay: RelayApi): Promise<void> {
  const token = await apnsDeviceToken();
  if (token === undefined) {
    usePush.setState({ status: 'denied' });
    return;
  }
  await relay.saveApnsToken({ token, environment: apnsEnvironment(__DEV__) });
  usePush.setState({ status: 'on' });
}

/** Derives every pairing's notification key and shares them with the extension (D5). */
async function shareKeys(): Promise<void> {
  const keyStore = createSecureKeyStore(systemRandom);
  const { keyPair } = await keyStore.identity();
  const keys = await Promise.all(
    (await keyStore.machines()).map(async (machine) => ({
      deviceId: machine.deviceId,
      key: toBase64(await rawNotificationKey(keyPair.privateKey, machine.publicKey)),
    })),
  );
  await saveSharedNotificationKeys(keys);
}

/**
 * Push notifications for the live connection (M4-05): registers the APNs token with the
 * relay when the app goes live, keeps the extension's notification keys in step with the
 * pairings, and carries out the notification buttons once the request's session is known.
 * Returns the stop function.
 */
export function startPushSync(): () => void {
  installNotificationHandler();
  void registerNotificationCategories();

  let relay: RelayApi | undefined;
  let paired = '';
  let queued: { readonly intent: NotificationIntent; readonly until: number }[] = [];

  const drain = () => {
    const { sessions, sample, decide } = useInbox.getState();
    const now = systemNow();
    queued = queued.filter(({ until }) => until > now);
    if (sample || queued.length === 0) return;
    queued = queued.filter(({ intent }) => {
      const outcome = resolveIntent(sessions, intent);
      if (outcome === undefined) return true;
      if (outcome.kind === 'decide') decide(outcome.input);
      else router.push(`/session/${outcome.sessionId}`);
      return false;
    });
  };

  const sync = () => {
    const state = useInbox.getState();
    if (state.relay !== relay) {
      relay = state.relay;
      if (relay !== undefined) {
        registerToken(relay).catch(() => usePush.setState({ status: 'failed' }));
      } else {
        usePush.setState({ status: 'off' });
      }
    }
    const machines = state.machines.map((machine) => machine.deviceId).join(',');
    if (relay !== undefined && machines !== paired) {
      paired = machines;
      void shareKeys().catch(() => undefined);
    }
    drain();
  };

  const stopIntents = onNotificationIntent((intent) => {
    queued.push({ intent, until: systemNow() + INTENT_TTL_MS });
    drain();
  });
  sync();
  const unsubscribe = useInbox.subscribe(sync);
  return () => {
    unsubscribe();
    stopIntents();
  };
}
