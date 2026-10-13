import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useStore } from 'zustand';

import { useAppState } from '../app-state.js';
import { pendingRequests } from '../realtime/realtime-store.js';
import type { RealtimeState } from '../realtime/realtime-store.js';
import { listenForNavigation } from './navigation.js';

/** How long after launch (or a return to the foreground) a pending request opens itself. */
export const LAUNCH_WINDOW_MS = 10_000;

const pendingCount = (state: RealtimeState): number => pendingRequests(state).length;
const mostUrgent = (state: RealtimeState): string | undefined =>
  pendingRequests(state)[0]?.request.id;

/**
 * Keeps the app pointed at what needs an answer (05 Rec-2): the badge shows the number
 * of pending requests, a notification tap on an open app navigates to its request, and
 * an app opened with a request pending goes straight to it, once.
 */
export function PendingWatch() {
  const { phone, platform } = useAppState();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const count = useStore(phone.realtime, pendingCount);
  const urgent = useStore(phone.realtime, mostUrgent);
  const armedUntil = useRef(0);

  useEffect(() => {
    platform.setBadge?.(count);
  }, [platform, count]);

  useEffect(() => {
    if (platform.serviceWorker === undefined) return;
    return listenForNavigation(platform.serviceWorker, (url) => void navigate(url));
  }, [platform, navigate]);

  useEffect(() => {
    const arm = () => {
      armedUntil.current = phone.now() + LAUNCH_WINDOW_MS;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') arm();
    };
    arm();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [phone]);

  useEffect(() => {
    // Already on a request (e.g. from the notification): nothing to jump to.
    if (pathname.startsWith('/requests/')) armedUntil.current = 0;
    if (urgent === undefined || phone.now() > armedUntil.current) return;
    armedUntil.current = 0;
    void navigate(`/requests/${urgent}`);
  }, [pathname, urgent, phone, navigate]);

  return null;
}
