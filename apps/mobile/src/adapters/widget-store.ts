import { ExtensionStorage } from '@bacons/apple-targets';

import {
  APP_GROUP,
  PENDING_LINK_KEY,
  SNAPSHOT_KEY,
  type WidgetSnapshot,
} from '../core/widget-snapshot';

const storage = new ExtensionStorage(APP_GROUP);

/**
 * Writes the snapshot to the App Group as a JSON string and asks WidgetKit to redraw the
 * widgets and the Control Center control. A no-op where the native module is missing
 * (Android, tests).
 */
export function publishWidgetSnapshot(snapshot: WidgetSnapshot): void {
  storage.set(SNAPSHOT_KEY, JSON.stringify(snapshot));
  ExtensionStorage.reloadWidget();
  ExtensionStorage.reloadControls();
}

/** Reads and clears the Control Center control's pending-link record (raw JSON or null). */
export function takePendingLink(): string | null {
  const raw = storage.get(PENDING_LINK_KEY);
  if (raw !== null) storage.remove(PENDING_LINK_KEY);
  return raw;
}
