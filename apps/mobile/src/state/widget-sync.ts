import { publishWidgetSnapshot } from '../adapters/widget-store';
import { systemNow } from '../adapters/system-clock';
import type { AgentSession } from '../core/model';
import { snapshotKey, widgetSnapshot } from '../core/widget-snapshot';
import { useInbox } from './store';

/**
 * Keeps the widgets' App Group snapshot in step with the inbox (M4-07). Writes only when
 * something the widgets show changed, so countdown ticks do not use up WidgetKit's reload
 * budget. Returns the unsubscribe function.
 */
export function startWidgetSync(): () => void {
  let last: string | undefined;
  const sync = ({
    sessions,
    sample,
  }: {
    readonly sessions: readonly AgentSession[];
    readonly sample: boolean;
  }) => {
    const snapshot = widgetSnapshot(sessions, systemNow(), sample);
    const key = snapshotKey(snapshot);
    if (key === last) return;
    last = key;
    publishWidgetSnapshot(snapshot);
  };
  sync(useInbox.getState());
  return useInbox.subscribe(sync);
}
