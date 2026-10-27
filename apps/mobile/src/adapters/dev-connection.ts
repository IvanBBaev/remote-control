import * as SecureStore from 'expo-secure-store';

import type { RelayConnection } from './relay-transport';

const KEY = 'rc.dev.connection';

/**
 * The developer relay and session token (M4-03), kept in the Keychain: the token is a
 * bearer credential, until the app has its own account sign-in.
 */
export async function loadDevConnection(): Promise<RelayConnection | undefined> {
  const text = await SecureStore.getItemAsync(KEY);
  if (text === null) return undefined;
  const parsed = JSON.parse(text) as Partial<RelayConnection>;
  return typeof parsed.origin === 'string' && typeof parsed.token === 'string'
    ? { origin: parsed.origin, token: parsed.token }
    : undefined;
}

export async function saveDevConnection(connection: RelayConnection): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(connection));
}

export async function clearDevConnection(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}
