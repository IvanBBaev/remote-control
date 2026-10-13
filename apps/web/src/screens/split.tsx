import { useSyncExternalStore } from 'react';
import { Link, Outlet } from 'react-router';

import { useAppState } from '../app-state.js';
import { SessionList } from './main.js';

/** From this width the sessions list and the detail sit side by side (05 Rec-10). */
export const WIDE_LAYOUT_QUERY = '(min-width: 900px)';

const NEVER = () => () => undefined;
const NARROW = () => false;

/** Whether the screen is wide enough for two panes; narrow where the platform cannot tell. */
export function useWideLayout(): boolean {
  const query = useAppState().platform.wideLayout;
  return useSyncExternalStore(query?.subscribe ?? NEVER, query?.matches ?? NARROW, NARROW);
}

/**
 * The sessions area (M2-05): on a phone each route is a screen of its own; on a wide
 * screen the sessions list stays on the left and the route's screen fills the right.
 */
export function SessionsSplit() {
  if (!useWideLayout()) return <Outlet />;
  return (
    <div className="split-view">
      <nav className="split-list" aria-label="Sessions">
        <SessionList />
        <div className="actions">
          <Link className="button primary" to="/new">
            New session
          </Link>
        </div>
      </nav>
      <div className="split-detail">
        <Outlet />
      </div>
    </div>
  );
}
