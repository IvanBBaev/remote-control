import { AppState, Linking } from 'react-native';

import { systemNow } from '../adapters/system-clock';
import { takePendingLink } from '../adapters/widget-store';
import { parsePendingLink } from '../core/widget-snapshot';

/**
 * When the app becomes active the control's intent may not have written its link yet, so
 * the app looks a few times over about three seconds.
 */
const CHECKS_MS = [0, 300, 800, 1_500, 3_000] as const;

/**
 * Opens the deep link the Control Center control left in the App Group (M4-07): on start
 * and whenever the app becomes active. Returns the stop function.
 */
export function startPendingLinkWatch(): () => void {
  let timers: ReturnType<typeof setTimeout>[] = [];
  const clear = () => {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
  };
  const check = () => {
    const url = parsePendingLink(takePendingLink(), systemNow());
    if (url === undefined) return;
    clear();
    void Linking.openURL(url);
  };
  const watch = () => {
    clear();
    timers = CHECKS_MS.map((delay) => setTimeout(check, delay));
  };
  watch();
  const subscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') watch();
  });
  return () => {
    clear();
    subscription.remove();
  };
}
