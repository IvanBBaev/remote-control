import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import {
  NOTIFICATION_CATEGORIES,
  notificationIntent,
  type NotificationIntent,
  type SharedNotificationKey,
} from '../core/notifications';
import { APP_GROUP } from '../core/widget-snapshot';

/**
 * The Keychain item the Notification Service Extension reads (NotificationService.swift):
 * expo-secure-store files it under the service `rc.push:no-auth`, the account `rc.push.keys`
 * and the App Group as the access group, readable after the first unlock so a push that
 * arrives on a locked phone still decrypts.
 */
const KEYS = 'rc.push.keys';
const SHARED: SecureStore.SecureStoreOptions = {
  keychainService: 'rc.push',
  accessGroup: APP_GROUP,
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/** Banners show while the app is open too; the inbox already lists the request. */
export function installNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: () =>
      Promise.resolve({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
  });
}

/** Registers the action buttons (M4-05). */
export async function registerNotificationCategories(): Promise<void> {
  for (const category of NOTIFICATION_CATEGORIES) {
    await Notifications.setNotificationCategoryAsync(
      category.identifier,
      category.actions.map((action) => ({ ...action, options: { ...action.options } })),
    );
  }
}

/**
 * Asks for permission once and returns the APNs device token (hex), or `undefined` when the
 * user declined or the platform is not iOS.
 */
export async function apnsDeviceToken(): Promise<string | undefined> {
  if (Platform.OS !== 'ios') return undefined;
  let { granted } = await Notifications.getPermissionsAsync();
  if (!granted) {
    ({ granted } = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    }));
  }
  if (!granted) return undefined;
  const token = await Notifications.getDevicePushTokenAsync();
  return typeof token.data === 'string' ? token.data.toLowerCase() : undefined;
}

/** Shares the pairings' notification keys with the extension. */
export async function saveSharedNotificationKeys(
  keys: readonly SharedNotificationKey[],
): Promise<void> {
  await SecureStore.setItemAsync(KEYS, JSON.stringify(keys), SHARED);
}

export async function clearSharedNotificationKeys(): Promise<void> {
  await SecureStore.deleteItemAsync(KEYS, SHARED);
}

/** The userInfo of a remote notification on iOS (`body` is what the extension added). */
function remotePayload(response: Notifications.NotificationResponse): unknown {
  const trigger: unknown = response.notification.request.trigger;
  if (typeof trigger !== 'object' || trigger === null) return undefined;
  const { type, payload } = trigger as { type?: unknown; payload?: unknown };
  return type === 'push' ? payload : undefined;
}

function intentOf(response: Notifications.NotificationResponse): NotificationIntent | undefined {
  return notificationIntent(response.actionIdentifier, remotePayload(response), response.userText);
}

/**
 * Calls `listener` for every button or tap on a notification, including the one that
 * launched the app. Returns the unsubscribe function.
 */
export function onNotificationIntent(listener: (intent: NotificationIntent) => void): () => void {
  const launch = Notifications.getLastNotificationResponse();
  if (launch !== null) {
    Notifications.clearLastNotificationResponse();
    const intent = intentOf(launch);
    if (intent !== undefined) listener(intent);
  }
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    Notifications.clearLastNotificationResponse();
    const intent = intentOf(response);
    if (intent !== undefined) listener(intent);
  });
  return () => subscription.remove();
}
